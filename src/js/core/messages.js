import { forkFromMessage } from '../chat/core.js';
function toggleMsgMenu(btn, role) {
  // Close any existing menu first
  closeMsgMenu();
  // Build menu
  const menu = document.createElement('div');
  menu.className = 'msg-menu-dropdown';
  menu.innerHTML = `<button class="msg-menu-item" onclick="forkFromMessageIdx(this)" data-i18n="auto.forkSessionHere">🔱 Fork session here</button>`;
  document.body.appendChild(menu);
  // Position it relative to the button
  const rect = btn.getBoundingClientRect();
  menu.style.top = rect.bottom + window.scrollY + 2 + 'px';
  menu.style.left = rect.left + window.scrollX + 'px';
  // Store message index on the menu for the fork handler
  const msgDiv = btn.closest('.chat-msg');
  const msgs = Array.from(msgDiv.parentElement.querySelectorAll('.chat-msg'));
  const idx = msgs.indexOf(msgDiv);
  menu.dataset.msgIdx = idx;
  menu.dataset.role = role;
  // Close on outside click
  setTimeout(() => { document.addEventListener('click', closeMsgMenu, { once: true }); }, 0);
}

function closeMsgMenu() {
  document.querySelectorAll('.msg-menu-dropdown').forEach(m => m.remove());
}

async function forkFromMessageIdx(el) {
  closeMsgMenu();
  const menu = el.closest('.msg-menu-dropdown');
  const msgIdx = parseInt(menu?.dataset?.msgIdx || '0', 10);
  await forkFromMessage(msgIdx);
}

export { toggleMsgMenu, closeMsgMenu, forkFromMessageIdx };
