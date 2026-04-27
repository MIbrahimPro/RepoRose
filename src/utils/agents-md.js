'use strict';

/**
AGENTS.md helper — injects a standard message for AI tools

creates or updates AGENTS.md with a note telling AI assistants
to read the map.json file for context about the repo

uses HTML comment markers so it knows what it wrote vs what you wrote
doesnt touch your content outside those markers
 */

const fs = require('fs');
const path = require('path');

const START_MARKER = '<!-- reporose:start -->';
const END_MARKER = '<!-- reporose:end -->';

const DEFAULT_PREAMBLE = `${START_MARKER}
> **AI agents:** read \`.reporose/map.json\` for the full file map, dependency graph, and per-file descriptions. Use it as your project context before answering questions about this repo.
${END_MARKER}`;

const CANDIDATE_NAMES = ['AGENTS.md', 'agents.md', 'Agents.md', 'AGENTS.MD', 'context.md', 'CONTEXT.md'];

// finds AGENTS.md or similar files
// checks various casings like AGENTS.md, agents.md, context.md, etc
// returns whether it exists and the full path
function findAgentsMd(repoPath) {
  for (const name of CANDIDATE_NAMES) {
    const fullPath = path.join(repoPath, name);
    if (fs.existsSync(fullPath)) {
      return { exists: true, path: fullPath, name };
    }
  }
  // Default to AGENTS.md if not found
  return { exists: false, path: path.join(repoPath, 'AGENTS.md'), name: 'AGENTS.md' };
}

// checks if content already has our reporose markers
// so we dont inject twice
function hasMarker(content) {
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}

// makes sure the AGENTS.md preamble exists
// - no file? creates one with just the preamble
// - file exists but no marker? prepends the preamble
// - file exists with marker? leaves it alone
function ensurePreamble(repoPath) {
  const { exists, path: filePath, name } = findAgentsMd(repoPath);

  if (!exists) {
    // Create new file with just the preamble
    fs.writeFileSync(filePath, DEFAULT_PREAMBLE + '\n', 'utf8');
    return { created: true, updated: false, path: filePath, name };
  }

  const content = fs.readFileSync(filePath, 'utf8');

  if (hasMarker(content)) {
    // Marker already present, don't touch anything
    return { created: false, updated: false, path: filePath, name };
  }

  // Prepend the preamble with a blank line separator
  const newContent = DEFAULT_PREAMBLE + '\n\n' + content;
  fs.writeFileSync(filePath, newContent, 'utf8');
  return { created: false, updated: true, path: filePath, name };
}

// extracts just the preamble between our markers
// returns null if markers arent there
function getPreamble(repoPath) {
  const { exists, path: filePath } = findAgentsMd(repoPath);
  if (!exists) return null;

  const content = fs.readFileSync(filePath, 'utf8');
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  return content.slice(startIdx, endIdx + END_MARKER.length);
}

module.exports = {
  ensurePreamble,
  getPreamble,
  findAgentsMd,
  START_MARKER,
  END_MARKER,
  DEFAULT_PREAMBLE,
};
