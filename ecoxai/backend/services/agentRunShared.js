'use strict';

/**
 * Shared agent-run helpers used by every container runtime backend.
 *
 * Both the Docker backend (containerManager) and the Singularity backend
 * (singularityManager) run the same Claude Code agent and parse the same
 * stream-json output, so the output formatter and the execution-log buffer
 * live here rather than being duplicated per backend.
 */

const dbManager = require('./databaseManager');

function formatClaudeOutput(json) {
  const { type, subtype } = json;
  let displayText = null;
  let logData = null;

  switch (type) {
    case 'system':
      if (subtype === 'init') {
        displayText = `\n━━━ Agent Session Initialized ━━━\nModel: ${json.model}\n`;
        logData = { type: 'init', model: json.model, permissionMode: json.permissionMode, sandboxId: json.sandboxId };
      }
      break;

    case 'assistant': {
      const content = json.message?.content || [];
      let output = '';
      const toolCalls = [];
      let thinking = null;
      for (const item of content) {
        if (item.type === 'text') output += `\n💭 ${item.text}\n`;
        else if (item.type === 'thinking') { output += `\n🧠 Thinking: ${item.thinking}\n`; thinking = item.thinking; }
        else if (item.type === 'tool_use') {
          output += `\n🔧 Tool: ${item.name} - Arguments: ${JSON.stringify(item.input)}\n`;
          toolCalls.push({ tool_id: item.id, tool_name: item.name, arguments: item.input });
        }
      }
      displayText = output || null;
      logData = { type: 'assistant_message', thinking, toolCalls, messageId: json.message?.id };
      break;
    }

    case 'user':
      if (json.message?.content) {
        const results = json.message.content.filter(c => c.type === 'tool_result');
        if (results.length > 0) {
          let output = '';
          const toolResults = [];
          for (const result of results) {
            const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
            output += `\n✓ Tool Result:\n${content.split('\n').map(l => '  ' + l).join('\n')}\n`;
            toolResults.push({ tool_call_id: result.tool_use_id, content: result.content, is_error: result.is_error || false });
          }
          displayText = output;
          logData = { type: 'tool_results', results: toolResults };
        }
      }
      break;

    case 'result':
      if (subtype === 'success') {
        displayText = `\n━━━ Execution Complete ━━━\nDuration: ${json.duration_ms}ms\nCost: $${json.total_cost_usd?.toFixed(4) || '0.0000'}\n\n✅ ${json.result}\n`;
        logData = { type: 'completion', duration_ms: json.duration_ms, total_cost_usd: json.total_cost_usd, num_turns: json.num_turns, result: json.result };
      } else if (subtype === 'error') {
        displayText = `\n❌ Error: ${json.error_message || 'Unknown error'}\n`;
        logData = { type: 'error', error_message: json.error_message, total_cost_usd: json.total_cost_usd };
      }
      break;
  }

  return { displayText, logData };
}

class ExecutionLogBuffer {
  constructor(runId) {
    this.runId = runId;
    this.steps = [];
    this.toolCalls = [];
    this.pendingToolCalls = new Map();
    this.currentTurn = 0;
    this.currentStep = 0;
    this.model = null;
    this.sandboxId = null;
    this.permissionMode = null;
    this.completionData = null;
    this.errorMessage = null;
  }

  addInitData(data) { this.model = data.model; this.sandboxId = data.sandboxId; this.permissionMode = data.permissionMode; }

  addAssistantMessage(data, timestamp = new Date().toISOString()) {
    this.currentTurn++;
    if (data.thinking) {
      this.steps.push({ run_id: this.runId, step_number: this.currentStep++, step_type: 'thinking', input: null, output: data.thinking, started_at: timestamp, completed_at: timestamp, duration_ms: 0, success: 1 });
    }
    const toolCallsSummary = data.toolCalls.map(tc => tc.tool_name).join(', ');
    this.steps.push({ run_id: this.runId, step_number: this.currentStep++, step_type: 'turn', input: data.thinking || null, output: toolCallsSummary || 'No tool calls', started_at: timestamp, completed_at: timestamp, duration_ms: 0, success: 1, metadata_json: JSON.stringify({ turn_number: this.currentTurn, message_id: data.messageId }) });
    for (const toolCall of data.toolCalls) {
      this.pendingToolCalls.set(toolCall.tool_id, { tool_name: toolCall.tool_name, arguments: toolCall.arguments, turn_number: this.currentTurn, started_at: timestamp });
    }
  }

  addToolResults(results, timestamp = new Date().toISOString()) {
    for (const result of results) {
      const pending = this.pendingToolCalls.get(result.tool_call_id);
      if (!pending) continue;
      const duration_ms = new Date(timestamp).getTime() - new Date(pending.started_at).getTime();
      this.toolCalls.push({ run_id: this.runId, turn_number: pending.turn_number, tool_id: result.tool_call_id, tool_name: pending.tool_name, arguments_json: JSON.stringify(pending.arguments), result_json: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), started_at: pending.started_at, completed_at: timestamp, duration_ms, success: result.is_error ? 0 : 1, error_message: result.is_error ? result.content : null });
      this.steps.push({ run_id: this.runId, step_number: this.currentStep++, step_type: 'tool_result', input: pending.tool_name, output: typeof result.content === 'string' ? result.content : JSON.stringify(result.content), started_at: pending.started_at, completed_at: timestamp, duration_ms, success: result.is_error ? 0 : 1, error_message: result.is_error ? result.content : null });
      this.pendingToolCalls.delete(result.tool_call_id);
    }
  }

  addCompletion(data) { this.completionData = data; }
  addError(message, costUsd) {
    this.errorMessage = message;
    if (costUsd != null) this.completionData = { total_cost_usd: costUsd };
  }

  async flush() {
    try {
      if (this.model) {
        await dbManager.updateRun(this.runId, { model: this.model });
      }
      if (this.steps.length > 0) await dbManager.createStepsBatch(this.steps);
      if (this.toolCalls.length > 0) await dbManager.createToolCallsBatch(this.toolCalls);
    } catch (error) {
      console.error(`[${this.runId}] Failed to flush execution log:`, error);
    }
  }
}

module.exports = { formatClaudeOutput, ExecutionLogBuffer };
