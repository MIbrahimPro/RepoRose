'use strict';

const fs = require('fs');
const path = require('path');

function buildProjectTree(files, repoPath) {
  const tree = {};
  
  for (const file of files) {
    const parts = file.path.split('/');
    let current = tree;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      
      if (isLast) {
        current[part] = {
          _file: {
            path: file.path,
            size: file.size_bytes,
            functions: (file.functions || []).length,
            imports: (file.imports || []).length,
          }
        };
      } else {
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    }
  }
  
  return tree;
}

function treeToString(tree, indent = 0) {
  const lines = [];
  const prefix = '  '.repeat(indent);
  
  const entries = Object.entries(tree).sort((a, b) => a[0].localeCompare(b[0]));
  
  for (const [name, value] of entries) {
    if (value._file) {
      const f = value._file;
      lines.push(`${prefix}|- ${name} (${f.size}b, ${f.functions} fn, ${f.imports} imports)`);
    } else {
      lines.push(`${prefix}|- ${name}/`);
      lines.push(treeToString(value, indent + 1));
    }
  }
  
  return lines.join('\n');
}

function buildFilterPrompt(files, repoPath) {
  // Filter out obvious non-code first
  const codeFiles = files.filter(f => f.type === 'code');
  const tree = buildProjectTree(codeFiles, repoPath);
  const treeStr = treeToString(tree);
  
  return {
    prompt: `You are analyzing a codebase to determine which files should be summarized by an AI code analysis tool.

Here is the project structure:

root/
${treeStr}

Review this file tree and identify files that should NOT be summarized because:
1. They are auto-generated files (lock files, generated types, build output)
2. They are test fixtures or mock data files
3. They are config files without significant logic
4. They are minified/bundled files
5. They have random/temporary names (like .extr, .tmp, hash-named files)

Return a JSON object with this exact structure:
{
  "filesToSummarize": ["path1", "path2", ...],
  "filesToSkip": ["path1", "path2", ...],
  "reasoning": "brief explanation"
}

Include ONLY code files with meaningful logic. Be aggressive about skipping generated/temp files.`,
    codeFiles,
  };
}

async function filterFilesWithAI(files, provider, repoPath, onLog) {
  const { prompt, codeFiles } = buildFilterPrompt(files, repoPath);
  
  if (!provider || provider.skip) {
    // No AI available, use heuristics
    return filterFilesHeuristic(codeFiles);
  }
  
  try {
    onLog?.('info', 'Asking AI to identify files worth summarizing...');
    
    const response = await provider.summarizeFile({
      name: 'file-filter',
      path: 'filter-request',
      language: 'json',
      type: 'code',
      size_bytes: prompt.length,
      snippet: prompt,
    });
    
    // Try to parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      const toSummarize = new Set(result.filesToSummarize || []);
      
      const filtered = codeFiles.map(f => ({
        ...f,
        summarizable: toSummarize.has(f.path),
        skipReason: toSummarize.has(f.path) ? undefined : 'filtered_by_ai',
      }));
      
      const skipped = filtered.filter(f => !f.summarizable).length;
      onLog?.('info', `AI filtered: ${skipped} files skipped, ${filtered.filter(f => f.summarizable).length} to summarize`);
      
      return filtered;
    }
  } catch (err) {
    onLog?.('warn', `AI file filter failed: ${err.message}, using heuristics`);
  }
  
  return filterFilesHeuristic(codeFiles);
}

function filterFilesHeuristic(files) {
  const skipPatterns = [
    /\.lock$/,
    /\.min\./,
    /\.bundle\./,
    /chunk-[a-z0-9]+/,
    /\.[a-f0-9]{8,}/,  // hash-named files
    /^\./,  // hidden files
    /test[\/]fixtures/,
    /__fixtures__/,
    /\.generated\./,
    /\.extr$/,
    /\.tmp$/,
    /\.temp$/,
    /dist[\/]/,
    /build[\/]/,
    /\.next[\/]/,
    /node_modules[\/]/,
  ];
  
  return files.map(f => {
    const shouldSkip = skipPatterns.some(p => p.test(f.path));
    return {
      ...f,
      summarizable: !shouldSkip,
      skipReason: shouldSkip ? 'filtered_by_heuristic' : undefined,
    };
  });
}

module.exports = {
  buildFilterPrompt,
  filterFilesWithAI,
  filterFilesHeuristic,
  buildProjectTree,
};
