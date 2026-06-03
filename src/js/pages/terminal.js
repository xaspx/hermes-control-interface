function terminalKey(key) {
  if (!termWs || termWs.readyState !== 1) return;
  const keyMap = {
    'ArrowUp': '\x1b[A',
    'ArrowDown': '\x1b[B',
    'ArrowLeft': '\x1b[D',
    'ArrowRight': '\x1b[C',
    'Enter': '\r',
    ' ': ' ',
  };
  const data = keyMap[key] || key;
  termWs.send(JSON.stringify({ type: 'terminal-input', data }));
}

function toggleTerminalFullscreen() {
  const panel = document.querySelector('.terminal-panel');
  if (!panel) return;
  const isFullscreen = panel.classList.toggle('terminal-fullscreen');
  document.getElementById('terminal-fullscreen').textContent = isFullscreen ? '⊡' : '⛶';
  if (isFullscreen) {
    document.getElementById('main').style.bottom = '0';
  } else {
    document.getElementById('main').style.bottom = '45vh';
  }
  // Refit terminal
  setTimeout(() => {
    if (termInstance && termInstance._fitAddon) {
      termInstance._fitAddon.fit();
    }
  }, 100);
}

export { terminalKey, toggleTerminalFullscreen };
