'use strict';

/**
ollama installer — handles the messy business of installing Ollama

supports Linux, macOS, Windows
- Linux/macOS: runs that curl | sh command (you know the one)
- Windows: just opens the browser cuz Windows installers are always GUI

also checks if the daemon is running and nags you about it
 */

const { spawn, spawnSync } = require('child_process');
const os = require('os');

// checks if ollama command exists
// basically runs `which ollama` and hopes for the best
function isInstalled() {
  const result = spawnSync('which', ['ollama'], { stdio: 'ignore' });
  return result.status === 0 || result.status === 1; // which returns 1 if not found on some systems
}

// checks if ollama daemon is actually running
// uses pgrep cuz thats what cool kids use i guess
function isRunning() {
  try {
    const result = spawnSync('pgrep', ['-x', 'ollama'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

// figures out how to install ollama based on your OS
// returns the command, args, and whether its a GUI installer
function getInstallCommand() {
  const platform = os.platform();

  if (platform === 'linux' || platform === 'darwin') {
    return {
      command: 'sh',
      args: ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'],
      label: 'curl -fsSL https://ollama.com/install.sh | sh',
      isGui: false,
    };
  }

  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', 'https://ollama.com/download'],
      label: 'Open ollama.com/download in your browser',
      isGui: true,
    };
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

// opens a URL in your default browser
// how? IDK, some platform-specific command magic
function openBrowser(url) {
  const platform = os.platform();
  let cmd, args;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// actually runs the install command and shows live output
// streams stdout/stderr so you can see whats happening
function runInstall(cmd, onLog) {
  return new Promise((resolve) => {
    if (cmd.isGui) {
      // GUI-based install (Windows) — just open the browser
      openBrowser('https://ollama.com/download');
      onLog('Browser opened to ollama.com/download');
      onLog('Please download and install Ollama, then return here.');
      resolve(true);
      return;
    }

    // CLI-based install (Linux/macOS)
    onLog(`Running: ${cmd.label}`);
    const child = spawn(cmd.command, cmd.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Show progress lines
      for (const line of text.split('\n').filter(Boolean)) {
        onLog(`  ${line}`);
      }
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      for (const line of text.split('\n').filter(Boolean)) {
        onLog(`  ${line}`);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        onLog('Installation complete!');
        resolve(true);
      } else {
        onLog(`Installation exited with code ${code}`);
        resolve(false);
      }
    });

    child.on('error', (err) => {
      onLog(`Installation failed: ${err.message}`);
      resolve(false);
    });
  });
}

// main entry point — checks if installed, asks for confirmation, runs install
// returns true if ollama is there (either already was or we just installed it)
async function installOllama(opts = {}) {
  const { yes = false, onLog = () => {} } = opts;

  // Check if already installed
  if (isInstalled()) {
    onLog('Ollama is already installed.');
    return true;
  }

  const cmd = getInstallCommand();
  const platform = os.platform();

  // Show what we're about to do
  onLog(`Platform: ${platform}`);
  onLog(`Install command: ${cmd.label}`);

  // Confirmation unless --yes
  if (!yes) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise((resolve) => {
      rl.question('Install Ollama now? [y/N] ', resolve);
    });
    rl.close();
    if (!/^y(es)?$/i.test(answer)) {
      onLog('Cancelled. Install manually from https://ollama.com');
      return false;
    }
  }

  // Run install
  const success = await runInstall(cmd, onLog);
  if (!success) {
    return false;
  }

  // For GUI installs (Windows), wait for user confirmation
  if (cmd.isGui) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await new Promise((resolve) => {
      rl.question('Press Enter once Ollama is installed...', resolve);
    });
    rl.close();
  }

  // Verify installation
  if (!isInstalled()) {
    onLog('Ollama does not appear to be installed yet.');
    onLog('Please install manually from https://ollama.com');
    return false;
  }

  onLog('Ollama installed successfully!');

  // Check if daemon is running
  if (!isRunning()) {
    onLog('');
    onLog('⚠️  Ollama daemon is not running.');
    onLog('Start it with: ollama serve');
    onLog('(Keep this running in a separate terminal)');
  } else {
    onLog('Ollama daemon is already running.');
  }

  return true;
}

module.exports = {
  isInstalled,
  isRunning,
  installOllama,
  getInstallCommand,
};
