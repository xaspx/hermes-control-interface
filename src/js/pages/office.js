import { destroyKanbanBoard, initKanbanBoard, startKanbanPoll, stopKanbanPoll } from '../core/state.js';
import { destroyMulticaPanel, initMulticaPanel, startMulticaPoll, stopMulticaPoll } from '../multica-issues-panel.js';

let activeView = 'kanban';

function stopOfficeAutoRefresh() {
  stopKanbanPoll();
  destroyKanbanBoard();
  stopMulticaPoll();
  destroyMulticaPanel();
}

async function loadOffice(container) {
  container.innerHTML = `
    <div id="office-page">
      <div class="office--page-header">
        <div>
          <div class="page-title" data-i18n="auto.office">Office</div>
          <div class="page-subtitle" data-i18n="auto.agentWorkspaceVisualization">Kanban board — live task visualization</div>
        </div>
        <div style="display:flex;gap:8px;" id="office-controls">
          <button class="btn btn-ghost btn-sm btn-active" data-view="kanban" onclick="window.switchOfficeView('kanban')">📋 Kanban</button>
          <button class="btn btn-ghost btn-sm" data-view="multica" onclick="window.switchOfficeView('multica')">🔗 Multica Issues</button>
        </div>
        <div style="display:flex;gap:8px;" id="office-board-controls">
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('main')">📋 main</button>
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('dev')">🛠 dev</button>
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('content')">📝 content</button>
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('trading')">💹 trading</button>
        </div>
      </div>
      <div id="office-kanban-root"></div>
    </div>
  `;

  activeView = 'kanban';
  // Init PixiJS Kanban in the root div
  await initKanbanBoard('office-kanban-root', 'main');
  startKanbanPoll(30000);
}

async function switchOfficeView(view) {
  if (view === activeView) return;
  activeView = view;

  document.querySelectorAll('#office-controls .btn').forEach((b) => {
    b.classList.toggle('btn-active', b.dataset.view === view);
  });
  const boardControls = document.getElementById('office-board-controls');
  if (boardControls) boardControls.style.display = view === 'kanban' ? '' : 'none';

  if (view === 'kanban') {
    stopMulticaPoll();
    destroyMulticaPanel();
    await initKanbanBoard('office-kanban-root', 'main');
    startKanbanPoll(30000);
  } else {
    stopKanbanPoll();
    destroyKanbanBoard();
    await initMulticaPanel('office-kanban-root');
    startMulticaPoll(5000);
  }
}
window.switchOfficeView = switchOfficeView;

export { stopOfficeAutoRefresh, loadOffice };
