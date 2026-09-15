'use strict';

/**
 * Filesystem-backed storage for the Singularity runtime.
 *
 * Mirrors the public API of volumeManager (the Docker implementation) exactly,
 * so every caller — orchestrator, routes, workspacePrep, jobPostCompletion —
 * works unchanged. Where the Docker version spins up a throwaway Alpine
 * container to move bytes in and out of a named volume, this version does plain
 * file I/O against directories that Singularity bind-mounts at run time.
 *
 * Layout under ECOXAI_STATE_DIR:
 *   workspaces/{jobId}/    → bind-mounted at /workspace
 *   datasets/              → bind-mounted at /datasets (read-only)
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const rc = require('./runtimeConfig');

/** Guard every caller-supplied relative path against escaping its root. */
function resolveInside(root, relative) {
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes its root: ${relative}`);
  }
  return full;
}

async function copyTree(src, dest) {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      await copyTree(path.join(src, entry), path.join(dest, entry));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

class LocalVolumeManager {
  constructor() {
    rc.ensureDirs();
  }

  sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /** No image pre-pull is needed — file operations run in this process. */
  async ensureImage() {
    return true;
  }

  async initializeDatasetVolume() {
    try {
      await fs.mkdir(rc.DATASETS_DIR, { recursive: true });
      console.log(`[Storage] Datasets directory ready: ${rc.DATASETS_DIR}`);
      return true;
    } catch (error) {
      console.error('Error initializing datasets directory:', error.message);
      return false;
    }
  }

  async createWorkspaceVolume(jobId) {
    const dir = rc.workspaceDir(jobId);
    try {
      await fs.mkdir(path.join(dir, 'output'), { recursive: true });
      await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
      console.log(`[Storage] Created workspace: ${dir}`);
      return dir;
    } catch (error) {
      console.error(`Error creating workspace for job ${jobId}:`, error.message);
      throw error;
    }
  }

  async copyNormalizedDatasetToVolume(datasetId, normalizedPath) {
    try {
      const dest = resolveInside(rc.DATASETS_DIR, datasetId);
      await fs.mkdir(dest, { recursive: true });
      await copyTree(normalizedPath, dest);
      console.log(`✓ Copied normalized dataset ${datasetId} to ${dest}`);
      return { success: true, sanitizedFilename: datasetId };
    } catch (error) {
      console.error('Error copying normalized dataset:', error.message);
      return { success: false, error: error.message };
    }
  }

  async copyCleanedDatasetToVolume(datasetId, jobId) {
    try {
      const content = await this.readArtifact(jobId, 'cleaned_data.feather');
      const destDir = resolveInside(rc.DATASETS_DIR, path.join(datasetId, 'cleaned'));
      await fs.mkdir(destDir, { recursive: true });
      await fs.writeFile(path.join(destDir, 'data.feather'), content);
      console.log(`✓ Copied cleaned_data.feather for ${datasetId} (${content.length} bytes)`);
      return true;
    } catch (error) {
      console.error(`Error copying cleaned dataset for ${datasetId}:`, error.message);
      return false;
    }
  }

  async removeDatasetFromVolume(datasetId, filename) {
    try {
      const target = resolveInside(rc.DATASETS_DIR, `${datasetId}_${this.sanitizeFilename(filename)}`);
      await fs.rm(target, { force: true, recursive: true });
      console.log(`✓ Removed dataset ${datasetId} from storage`);
      return true;
    } catch (error) {
      console.error('Error removing dataset:', error.message);
      return false;
    }
  }

  /**
   * Read one artifact, preferring output/ and falling back to the workspace root
   * — the same lookup order the Docker implementation uses.
   */
  async readArtifact(jobId, filePath) {
    const root = rc.workspaceDir(jobId);
    const candidates = [
      resolveInside(root, path.join('output', filePath)),
      resolveInside(root, filePath),
    ];
    for (const candidate of candidates) {
      try {
        return await fs.readFile(candidate);
      } catch { /* try the next location */ }
    }
    throw new Error(`Artifact not found for job ${jobId}: ${filePath}`);
  }

  async readArtifacts(jobId, relativePaths) {
    const root = rc.workspaceDir(jobId);
    return Promise.all(relativePaths.map(async (filePath) => {
      const candidates = [
        resolveInside(root, path.join('output', path.basename(filePath))),
        resolveInside(root, filePath),
      ];
      for (const candidate of candidates) {
        try {
          return { filePath, buffer: await fs.readFile(candidate) };
        } catch { /* try the next location */ }
      }
      return { filePath, error: new Error(`Not found: ${filePath}`) };
    }));
  }

  async writeTaskFile(jobId, taskContent) {
    return this.writeWorkspaceFile(jobId, 'task.txt', taskContent);
  }

  async writeWorkspaceFile(jobId, filename, content) {
    try {
      const target = resolveInside(rc.workspaceDir(jobId), filename);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      await fs.writeFile(target, buffer);
      console.log(`✓ Wrote ${filename} for job ${jobId}: ${buffer.length} bytes`);
      return true;
    } catch (error) {
      console.error(`Error writing ${filename} for job ${jobId}:`, error.message);
      return false;
    }
  }

  async writeWorkspaceFiles(jobId, files) {
    try {
      const entries = Object.entries(files);
      for (const [filename, content] of entries) {
        const target = resolveInside(rc.workspaceDir(jobId), filename);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, Buffer.isBuffer(content) ? content : Buffer.from(content));
      }
      console.log(`✓ Wrote ${entries.length} files to workspace ${jobId}`);
      return true;
    } catch (error) {
      console.error(`Error writing files to workspace ${jobId}:`, error.message);
      return false;
    }
  }

  async copyCLAUDEmdToWorkspace(jobId) {
    try {
      const source = path.join(__dirname, '../docker/CLAUDE.md');
      await fs.copyFile(source, path.join(rc.workspaceDir(jobId), 'CLAUDE.md'));
      return true;
    } catch (error) {
      console.error(`Error copying CLAUDE.md for job ${jobId}:`, error.message);
      return false;
    }
  }

  /**
   * Copy the selected skills into .claude/skills/{skill-name}/, flattening the
   * "visibility:name" id to just the name — the layout CLAUDE.md tells agents
   * to expect.
   */
  async copySkillsToWorkspace(jobId, skillIds) {
    if (!skillIds || skillIds.length === 0) {
      console.log(`No skills to copy for job ${jobId}`);
      return true;
    }
    try {
      const skillsRoot = path.join(__dirname, '../skills');
      const destRoot = path.join(rc.workspaceDir(jobId), '.claude', 'skills');
      await fs.mkdir(destRoot, { recursive: true });

      let copied = 0;
      for (const skillId of skillIds) {
        const parts = String(skillId).split(':', 2);
        if (parts.length < 2 || !parts[1]) {
          console.warn(`Skipping malformed skill ID (expected "visibility:name"): ${skillId}`);
          continue;
        }
        const [visibility, skillName] = parts;
        let source;
        try {
          source = resolveInside(skillsRoot, path.join(visibility, skillName));
          await fs.access(source);
        } catch {
          console.warn(`Skill not found: ${skillId}`);
          continue;
        }
        await copyTree(source, path.join(destRoot, skillName));
        copied++;
      }
      console.log(`✓ Copied ${copied} skill(s) to workspace ${jobId}`);
      return true;
    } catch (error) {
      console.error(`Error copying skills for job ${jobId}:`, error.message);
      return false;
    }
  }

  async deleteWorkspaceVolume(jobId) {
    const dir = rc.workspaceDir(jobId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      console.log(`[Storage] Deleted workspace ${dir}`);
    } catch (err) {
      console.warn(`[Storage] Could not delete ${dir}:`, err.message);
    }
  }

  async deleteAllWorkspaceVolumes() {
    try {
      const entries = await fs.readdir(rc.WORKSPACES_DIR).catch(() => []);
      for (const entry of entries) {
        await fs.rm(path.join(rc.WORKSPACES_DIR, entry), { recursive: true, force: true })
          .catch(err => console.warn(`[Storage] Could not delete ${entry}:`, err.message));
      }
      console.log(`[Storage] Deleted ${entries.length} workspace(s)`);
    } catch (err) {
      console.warn('[Storage] Could not list workspaces:', err.message);
    }
  }

  async deleteDatasetVolume() {
    try {
      await fs.rm(rc.DATASETS_DIR, { recursive: true, force: true });
      await fs.mkdir(rc.DATASETS_DIR, { recursive: true });
      console.log('[Storage] Cleared datasets directory');
    } catch (err) {
      console.warn('[Storage] Could not clear datasets directory:', err.message);
    }
  }

  /**
   * Read a file addressed the way the Docker backend addresses it — by volume
   * name plus an in-container absolute path.
   */
  async readFileFromVolume(volumeName, filePath) {
    const inContainer = filePath.replace(/^\/+/, '');
    if (volumeName === 'ecoxai-datasets' || inContainer.startsWith('datasets/')) {
      return fs.readFile(resolveInside(rc.DATASETS_DIR, inContainer.replace(/^datasets\//, '')));
    }
    const jobId = volumeName.replace(/^ecoxai-workspace-/, '');
    return fs.readFile(resolveInside(rc.workspaceDir(jobId), inContainer.replace(/^workspace\//, '')));
  }

  async readDatasetContext(datasetId) {
    const contextFiles = ['structure.json', 'semantic.json', 'confidence.json', 'provenance.json'];
    const context = {};
    const base = resolveInside(rc.DATASETS_DIR, path.join(datasetId, 'normalized'));

    for (const filename of contextFiles) {
      try {
        const raw = await fs.readFile(path.join(base, filename), 'utf-8');
        context[filename.replace('.json', '')] = JSON.parse(raw);
      } catch (error) {
        console.warn(`Could not read ${filename} for dataset ${datasetId}: ${error.message}`);
      }
    }
    console.log(`✓ Read dataset context for ${datasetId}: ${Object.keys(context).length} files`);
    return context;
  }

  /** Absolute host paths the Singularity backend binds into the container. */
  hostPaths(jobId) {
    return { workspace: rc.workspaceDir(jobId), datasets: rc.DATASETS_DIR };
  }

  workspaceExists(jobId) {
    return fsSync.existsSync(rc.workspaceDir(jobId));
  }
}

module.exports = new LocalVolumeManager();
module.exports.LocalVolumeManager = LocalVolumeManager;
