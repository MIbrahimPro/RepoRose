'use strict';

/**
prompt builder — turns file data into prompts for AI providers

builds structured inputs that all providers use
keeps the prompt logic in one place so its consistent

NOTE: function descriptions used to exist, but I removed them
since they werent very needed. the code is still here,
you can add it back if you want.
 */

// builds the input object for file summarization
// includes file metadata, imports, exports, functions, snippet
function buildFileInput(file, snippet, options = {}) {
  return {
    name: file.name,
    path: file.path,
    language: file.language,
    type: file.type,
    size_bytes: file.size_bytes,
    imports: (file.imports || []).map((i) => ({ source: i.source, type: i.type })),
    exported: (file.exported || []).map((e) => ({ name: e.name, type: e.type })),
    functions: (file.functions || []).map((f) => ({
      name: f.name,
      type: f.type,
      signature: f.signature,
    })),
    descriptionHints: {
      packageImports: (file.imports || []).filter((i) => i.type === 'package').map((i) => i.source),
      fileImports: (file.imports || []).filter((i) => i.type === 'file').map((i) => i.source),
      functionNames: (file.functions || []).map((f) => f.name),
      exportNames: (file.exported || []).map((e) => e.name),
    },
    snippet: snippet || '',
    // Optional repo-level context (e.g. AGENTS.md). Empty when the model's
    // context window is too small to afford it.
    repoContext: options.repoContext || '',
  };
}

// builds input for full file analysis with all content
// used when we have the complete file content, not just a snippet
function buildFullFileInput(file, chunks, context = {}) {
  return {
    name: file.name,
    path: file.path,
    language: file.language,
    type: file.type,
    size_bytes: file.size_bytes,
    imports: (file.imports || []).map((i) => ({ source: i.source, type: i.type })),
    exported: (file.exported || []).map((e) => ({ name: e.name, type: e.type })),
    functions: (file.functions || []).map((f) => ({
      name: f.name,
      type: f.type,
      signature: f.signature,
      line_start: f.line_start,
      line_end: f.line_end,
    })),
    chunks,
    totalChunks: chunks.length,
    dependencyDescriptions: context.dependencyDescriptions || {},
    repoContext: context.repoContext || '',
  };
}

// builds input for a single function
// NOTE: this used to be used for function summaries
// but i removed that feature. code is still here if you want it.
function buildFunctionInput(file, fn) {
  return {
    name: fn.name,
    type: fn.type,
    signature: fn.signature,
    parameters: fn.parameters || [],
    return_type: fn.return_type || null,
    file: file.name,
    file_path: file.path,
    language: file.language,
  };
}

// renders the actual prompt text sent to AI for file summaries
// includes the file context, snippet, and instructions
function renderFilePrompt(input) {
  const exportNames = input.exported.length
    ? input.exported.map((e) => e.name).join(', ')
    : 'none';
  const importNames = input.imports.length
    ? input.imports.map((i) => i.source).join(', ')
    : 'none';
  const lines = ['You are analyzing a code file for a code navigation tool.'];
  if (input.repoContext) {
    lines.push('', '--- Repository overview (from AGENTS.md) ---', input.repoContext, '--- end overview ---');
  }
  return [
    ...lines,
    '',
    `File: ${input.name}`,
    `Path: ${input.path}`,
    `Language: ${input.language}`,
    `Size: ${input.size_bytes} bytes`,
    `Exports: ${exportNames}`,
    `Imports: ${importNames}`,
    `Functions defined: ${input.functions.length}`,
    '',
    'The file starts with:',
    input.snippet || '(no preview available)',
    '',
    'Write a dense technical description of this file.',
    'Focus on behavior, not just structure.',
    'Explicitly cover, when the preview supports it:',
    '- the file\'s main responsibility',
    '- what user-facing workflow, UI section, route, or backend task it implements',
    '- important state, effects, API calls, auth, search, forms, or conditional rendering',
    '- what it imports/coordinates and what it exports',
    '- any important limitations: if you only have a preview, say "Based on the available preview..." instead of overclaiming',
    '',
    'Output requirements:',
    '- 4-6 sentences',
    '- one compact paragraph',
    '- plain English, technical and specific',
    '- do not say "this file contains" unless needed; describe what it actually does',
  ].join('\n');
}

// renders prompt for full file analysis with multiple chunks
// handles partial results from previous chunks
function renderFullFilePrompt(input, partIndex = 0, previousDescription = '') {
  const exportNames = input.exported.length
    ? input.exported.map((e) => e.name).join(', ')
    : 'none';
  const importNames = input.imports.length
    ? input.imports.map((i) => i.source).join(', ')
    : 'none';

  const lines = [
    'You are analyzing a code file for a code navigation tool. Your goal is to understand what this file does and how it fits into the codebase.',
  ];
  if (input.repoContext) {
    lines.push(
      '',
      '--- Repository overview (from AGENTS.md) ---',
      input.repoContext,
      '--- end overview ---',
    );
  }
  lines.push(
    '',
    `File: ${input.name}`,
    `Path: ${input.path}`,
    `Language: ${input.language}`,
    `Size: ${input.size_bytes} bytes`,
    `Exports: ${exportNames}`,
    `Imports: ${importNames}`,
    `Functions defined: ${input.functions.length}`,
    '',
  );

  // Add dependency descriptions if available
  const depDescs = Object.entries(input.dependencyDescriptions || {});
  if (depDescs.length > 0) {
    lines.push('Files this module depends on (with descriptions):');
    for (const [depPath, desc] of depDescs) {
      lines.push(`  - ${depPath}: ${desc}`);
    }
    lines.push('');
  }

  if (input.totalChunks === 1) {
    // Single chunk - show full content
    lines.push('Full file content:');
    lines.push('```');
    lines.push(input.chunks[0]);
    lines.push('```');
  } else {
    // Multi-part
    lines.push(`This is part ${partIndex + 1} of ${input.totalChunks}.`);
    if (previousDescription) {
      lines.push('');
      lines.push('Description of previous parts combined:');
      lines.push(previousDescription);
    }
    lines.push('');
    lines.push(`Content of part ${partIndex + 1}:`);
    lines.push('```');
    lines.push(input.chunks[partIndex]);
    lines.push('```');
  }

  lines.push('');
  if (input.totalChunks === 1 || partIndex === input.totalChunks - 1) {
    // Last part (or only part) - ask for final summary
    lines.push('Based on the file content above, provide a comprehensive description that explains:');
    lines.push('1. What this file actually does in the product or system');
    lines.push('2. What workflows, UI sections, routes, or backend behaviors it implements');
    lines.push('3. Important state, side effects, API/network calls, auth/search/forms, or conditional logic');
    lines.push('4. How it fits into the codebase (what it depends on, what depends on it)');
    lines.push('5. Key implementation details or patterns that matter for another AI reading this map');
    lines.push('');
    lines.push('Format: 5-8 sentences, one compact paragraph, technical but clear.');
    lines.push('Be concrete. Prefer statements like "renders the authenticated dashboard shell and switches panels from local nav state" over generic phrases like "defines a dashboard component".');
  } else {
    // Intermediate part - ask for partial summary
    lines.push(`Please provide a brief but concrete summary of what you've seen so far in parts 1-${partIndex + 1}.`);
    lines.push('Keep track of responsibilities, state/effects, external integrations, and major UI or business logic so the next step can build a full description.');
  }

  return lines.join('\n');
}

// renders prompt for function summaries
// NOTE: not currently used since i removed function descriptions
// but you can add it back if you want
function renderFunctionPrompt(input) {
  return [
    'What does this function do?',
    '',
    `Function name: ${input.name}`,
    `Signature: ${input.signature}`,
    `File: ${input.file}`,
    '',
    'Provide a 1-2 sentence summary of what this function does.',
  ].join('\n');
}

module.exports = {
  buildFileInput,
  buildFullFileInput,
  buildFunctionInput,
  renderFilePrompt,
  renderFullFilePrompt,
  renderFunctionPrompt,
};
