'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_FILENAME = 'index.json';
const FILES_DIRNAME = 'files';

function getOutDir(repoPath, outDir) {
  return path.resolve(repoPath, outDir || '.reporose');
}

function ensureDirs(repoPath, outDir) {
  const base = getOutDir(repoPath, outDir);
  const filesDir = path.join(base, FILES_DIRNAME);
  fs.mkdirSync(filesDir, { recursive: true });
  return { base, filesDir };
}

function writeIndex(repoPath, indexData, outDir) {
  const { base } = ensureDirs(repoPath, outDir);
  const indexPath = path.join(base, INDEX_FILENAME);
  const tmp = indexPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(indexData, null, 2) + '\n');
  fs.renameSync(tmp, indexPath);
  return indexPath;
}

function writeFileData(repoPath, fileId, fileData, outDir) {
  const { filesDir } = ensureDirs(repoPath, outDir);
  const filePath = path.join(filesDir, `${fileId}.json`);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(fileData, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
  return filePath;
}

function readIndex(repoPath, outDir) {
  const indexPath = path.join(getOutDir(repoPath, outDir), INDEX_FILENAME);
  if (!fs.existsSync(indexPath)) return null;
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function readFileData(repoPath, fileId, outDir) {
  const filePath = path.join(getOutDir(repoPath, outDir), FILES_DIRNAME, `${fileId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildIndexFromMap(map) {
  const fileIndex = map.files.map(f => ({
    id: f.id,
    path: f.path,
    name: f.name,
    type: f.type,
    language: f.language,
    size_bytes: f.size_bytes,
    importance_score: f.importance_score,
    description: f.description?.substring(0, 200) || '',
    tags: f.tags || [],
    hash: f.hash,
  }));

  return {
    metadata: map.metadata,
    files: fileIndex,
    packages: map.packages,
    networks: map.networks,
    circular_dependencies: map.circular_dependencies,
    statistics: map.statistics,
    links: map.links.map(l => ({
      id: l.id,
      from_file_id: l.from_file_id,
      to_file_id: l.to_file_id,
      to_package_id: l.to_package_id,
      type: l.type,
      weight: l.weight,
    })),
  };
}

function splitAndSaveMap(repoPath, map, outDir) {
  const { base, filesDir } = ensureDirs(repoPath, outDir);
  
  // Write individual file data
  for (const file of map.files) {
    const fileData = {
      ...file,
      // Full description, tags, functions, imports, exports
    };
    writeFileData(repoPath, file.id, fileData, outDir);
  }

  // Write lightweight index
  const index = buildIndexFromMap(map);
  writeIndex(repoPath, index, outDir);

  return { indexPath: path.join(base, INDEX_FILENAME), filesDir };
}

function loadFullMap(repoPath, outDir) {
  const index = readIndex(repoPath, outDir);
  if (!index) return null;

  const files = [];
  for (const fileIdx of index.files) {
    const fullData = readFileData(repoPath, fileIdx.id, outDir);
    if (fullData) {
      files.push(fullData);
    } else {
      // Fallback to index data if full file missing
      files.push(fileIdx);
    }
  }

  return {
    metadata: index.metadata,
    files,
    packages: index.packages,
    networks: index.networks,
    circular_dependencies: index.circular_dependencies,
    statistics: index.statistics,
    links: index.links,
  };
}

function searchFiles(repoPath, query, outDir, options = {}) {
  const index = readIndex(repoPath, outDir);
  if (!index) return [];

  const q = query.toLowerCase();
  const limit = options.limit || 10;
  const includeFull = options.includeFull || false;

  const matches = index.files
    .filter(f => {
      if (f.path.toLowerCase().includes(q)) return true;
      if (f.description?.toLowerCase().includes(q)) return true;
      if (f.tags?.some(t => t.toLowerCase().includes(q))) return true;
      return false;
    })
    .slice(0, limit)
    .map(f => {
      if (includeFull) {
        const fullData = readFileData(repoPath, f.id, outDir);
        return fullData || f;
      }
      return f;
    });

  return matches;
}

function getFileByPath(repoPath, filePath, outDir) {
  const index = readIndex(repoPath, outDir);
  if (!index) return null;
  
  const fileIdx = index.files.find(f => f.path === filePath);
  if (!fileIdx) return null;
  
  return readFileData(repoPath, fileIdx.id, outDir);
}

module.exports = {
  writeIndex,
  writeFileData,
  readIndex,
  readFileData,
  buildIndexFromMap,
  splitAndSaveMap,
  loadFullMap,
  searchFiles,
  getFileByPath,
  ensureDirs,
  INDEX_FILENAME,
  FILES_DIRNAME,
};
