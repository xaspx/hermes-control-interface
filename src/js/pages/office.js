import { destroyKanbanBoard, initKanbanBoard, startKanbanPoll, stopKanbanPoll } from '../core/state.js';
function stopOfficeAutoRefresh() {
  stopKanbanPoll();
  destroyKanbanBoard();
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
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('main')">📋 main</button>
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('dev')">🛠 dev</button>
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('content')">📝 content</button>
          <button class="btn btn-ghost btn-sm" onclick="if(window.switchKanbanBoard)switchKanbanBoard('trading')">💹 trading</button>
        </div>
      </div>
      <div id="office-kanban-root"></div>
    </div>
  `;

  // Init PixiJS Kanban in the root div
  await initKanbanBoard('office-kanban-root', 'main');
  startKanbanPoll(30000);
}

export { stopOfficeAutoRefresh, loadOffice };
