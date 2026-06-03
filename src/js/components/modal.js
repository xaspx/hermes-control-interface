function closeModal() {
  document.querySelectorAll('.modal-overlay').forEach(el => el.remove());
}

function showModal({ title, message, inputs = [], buttons = [] }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };

    let inputsHtml = inputs.map((inp, i) =>
      `<input class="modal-input" id="modal-input-${i}" type="${inp.type || 'text'}" placeholder="${inp.placeholder || ''}" value="${inp.value || ''}" autocomplete="off" />`
    ).join('');

    let buttonsHtml = buttons.map((btn, i) =>
      `<button class="btn ${btn.primary ? 'btn-primary' : 'btn-ghost'}" id="modal-btn-${i}">${btn.text}</button>`
    ).join('');

    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${title}</div>
        ${message ? `<div class="modal-message">${message}</div>` : ''}
        ${inputsHtml}
        <div class="modal-actions">${buttonsHtml}</div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Focus first input
    const firstInput = overlay.querySelector('.modal-input');
    if (firstInput) setTimeout(() => firstInput.focus(), 50);

    // Handle buttons — capture input values before closing
    buttons.forEach((btn, i) => {
      document.getElementById(`modal-btn-${i}`)?.addEventListener('click', () => {
        const inputValues = inputs.map((_, j) => document.getElementById(`modal-input-${j}`)?.value || '');
        overlay.remove();
        resolve({
          action: btn.value !== undefined ? btn.value : true,
          inputs: inputValues,
        });
      });
    });
  });
}

async function customAlert(message, title = 'Notice') {
  await showModal({ title, message, buttons: [{ text: 'OK', primary: true }] });
}

async function customConfirm(message, title = 'Confirm') {
  const result = await showModal({
    title,
    message,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Confirm', primary: true, value: true },
    ],
  });
  return result?.action === true;
}

async function customPrompt(message, defaultValue = '', title = 'Input') {
  const result = await showModal({
    title,
    message,
    inputs: [{ placeholder: message, value: defaultValue }],
    buttons: [
      { text: 'Cancel', value: null },
      { text: 'OK', primary: true, value: 'ok' },
    ],
  });
  if (!result || result.action === null) return null;
  return result.inputs[0] || '';
}

export { closeModal, showModal, customAlert, customConfirm, customPrompt };
