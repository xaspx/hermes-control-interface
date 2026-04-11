(function(){let e=document.createElement(`link`).relList;if(e&&e.supports&&e.supports(`modulepreload`))return;for(let e of document.querySelectorAll(`link[rel="modulepreload"]`))n(e);new MutationObserver(e=>{for(let t of e)if(t.type===`childList`)for(let e of t.addedNodes)e.tagName===`LINK`&&e.rel===`modulepreload`&&n(e)}).observe(document,{childList:!0,subtree:!0});function t(e){let t={};return e.integrity&&(t.integrity=e.integrity),e.referrerPolicy&&(t.referrerPolicy=e.referrerPolicy),e.crossOrigin===`use-credentials`?t.credentials=`include`:e.crossOrigin===`anonymous`?t.credentials=`omit`:t.credentials=`same-origin`,t}function n(e){if(e.ep)return;e.ep=!0;let n=t(e);fetch(e.href,n)}})();var e={user:null,page:`home`,theme:localStorage.getItem(`hci-theme`)||`dark`,notifications:[],notifInterval:null};function t(){document.documentElement.setAttribute(`data-theme`,e.theme),r()}function n(){e.theme=e.theme===`dark`?`light`:`dark`,document.documentElement.setAttribute(`data-theme`,e.theme),localStorage.setItem(`hci-theme`,e.theme),r()}function r(){let t=document.getElementById(`theme-icon`);t&&(t.textContent=e.theme===`dark`?`🌙`:`☀️`)}async function i(){try{let t=await fetch(`/api/auth/me`,{credentials:`include`});if(t.ok)return e.user=(await t.json()).user,o(),!0}catch{}return a(),!1}function a(){document.getElementById(`login-overlay`).classList.remove(`hidden`),document.getElementById(`app`).style.display=`none`}function o(){document.getElementById(`login-overlay`).classList.add(`hidden`),document.getElementById(`app`).style.display=`block`,s(),c(e.page),v()}function s(){e.user&&(document.getElementById(`user-name`).textContent=e.user.username,document.getElementById(`user-role`).textContent=e.user.role)}document.getElementById(`login-form`)?.addEventListener(`submit`,async t=>{t.preventDefault();let n=document.getElementById(`login-username`).value,r=document.getElementById(`login-password`).value,i=document.getElementById(`login-error`);try{let t=await(await fetch(`/api/auth/login`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({username:n,password:r}),credentials:`include`})).json();t.ok?(e.user=t.user,i.textContent=``,o()):i.textContent=t.error||`Login failed`}catch{i.textContent=`Connection error`}}),document.getElementById(`setup-form`)?.addEventListener(`submit`,async t=>{t.preventDefault();let n=document.getElementById(`setup-username`).value,r=document.getElementById(`setup-password`).value,i=document.getElementById(`setup-password-confirm`).value,a=document.getElementById(`login-error`);if(r!==i){a.textContent=`Passwords do not match`;return}if(r.length<8){a.textContent=`Password must be at least 8 characters`;return}try{let t=await(await fetch(`/api/auth/setup`,{method:`POST`,headers:{"Content-Type":`application/json`},body:JSON.stringify({username:n,password:r}),credentials:`include`})).json();t.ok?(e.user=t.user,a.textContent=``,o()):a.textContent=t.error||`Setup failed`}catch{a.textContent=`Connection error`}});function c(t,n={}){e.page=t,document.querySelectorAll(`.nav-link`).forEach(e=>{e.classList.toggle(`active`,e.dataset.page===t)}),document.querySelectorAll(`.page`).forEach(e=>e.classList.remove(`active`));let r=document.getElementById(`page-${t}`);r&&r.classList.add(`active`),l(t,n)}async function l(e,t={}){let n=document.getElementById(`page-${e}`);if(n){n.innerHTML=`<div class="loading">Loading</div>`;try{switch(e){case`home`:await u(n);break;case`agents`:await d(n);break;case`agent-detail`:await f(n,t);break;case`monitor`:await p(n);break;case`skills`:await m(n);break;case`maintenance`:await h(n);break;default:n.innerHTML=`<div class="empty">Page not found</div>`}}catch(e){n.innerHTML=`<div class="empty">Error loading page: ${e.message}</div>`}}}async function u(e){e.innerHTML=`
    <div class="page-header">
      <div>
        <div class="page-title">Home</div>
        <div class="page-subtitle">System overview</div>
      </div>
    </div>
    <div class="card-grid" id="home-cards">
      <div class="card">
        <div class="card-title">System Health</div>
        <div class="loading">Loading</div>
      </div>
      <div class="card">
        <div class="card-title">Hermes</div>
        <div class="loading">Loading</div>
      </div>
      <div class="card">
        <div class="card-title">Token Usage</div>
        <div class="loading">Loading</div>
      </div>
    </div>
  `;try{let e=await y(`/api/system/health`),t=document.getElementById(`home-cards`);e.ok&&(t.innerHTML=`
        <div class="card">
          <div class="card-title">System Health</div>
          <div style="margin-top:12px;">
            <div style="margin-bottom:8px;">CPU: ${e.cpu||`N/A`}</div>
            <div style="margin-bottom:8px;">RAM: ${e.ram||`N/A`}</div>
            <div>Disk: ${e.disk||`N/A`}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Hermes</div>
          <div style="margin-top:12px;">
            <div style="margin-bottom:8px;">Version: ${e.hermes_version||`N/A`}</div>
            <div style="margin-bottom:8px;">Agents: ${e.agents||0}</div>
            <div>Sessions: ${e.sessions||0}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Token Usage (7d)</div>
          <div class="loading">Coming soon</div>
        </div>
      `)}catch{}}async function d(e){e.innerHTML=`
    <div class="page-header">
      <div>
        <div class="page-title">Agents</div>
        <div class="page-subtitle">Manage your Hermes profiles</div>
      </div>
      <button class="btn btn-primary" id="create-agent-btn">+ Create Agent</button>
    </div>
    <div class="card-grid" id="agents-grid">
      <div class="loading">Loading agents</div>
    </div>
  `}async function f(e,t){e.innerHTML=`
    <div class="page-header">
      <div>
        <div class="page-title">Agent: ${t.name||`Unknown`}</div>
        <div class="page-subtitle">Agent detail</div>
      </div>
      <button class="btn btn-ghost" onclick="navigate('agents')">← Back</button>
    </div>
    <div class="tabs" id="agent-tabs">
      <button class="tab active" data-tab="dashboard">Dashboard</button>
      <button class="tab" data-tab="sessions">Sessions</button>
      <button class="tab" data-tab="gateway">Gateway</button>
      <button class="tab" data-tab="config">Config</button>
      <button class="tab" data-tab="memory">Memory</button>
    </div>
    <div id="agent-tab-content">
      <div class="loading">Loading</div>
    </div>
  `}async function p(e){e.innerHTML=`
    <div class="page-header">
      <div>
        <div class="page-title">System Monitor</div>
        <div class="page-subtitle">System resources and services</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card"><div class="card-title">CPU / RAM / Disk</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Services</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Cron Jobs</div><div class="loading">Loading</div></div>
    </div>
  `}async function m(e){e.innerHTML=`
    <div class="page-header">
      <div>
        <div class="page-title">Skills Marketplace</div>
        <div class="page-subtitle">Browse and manage skills</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card"><div class="card-title">Installed Skills</div><div class="loading">Loading</div></div>
    </div>
  `}async function h(e){e.innerHTML=`
    <div class="page-header">
      <div>
        <div class="page-title">Maintenance</div>
        <div class="page-subtitle">System tools and diagnostics</div>
      </div>
    </div>
    <div class="card-grid">
      <div class="card"><div class="card-title">Doctor</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Update</div><div class="loading">Loading</div></div>
      <div class="card"><div class="card-title">Users</div><div class="loading">Loading</div></div>
    </div>
  `}async function g(){try{let t=await y(`/api/notifications`);t.ok&&t.notifications&&(e.notifications=t.notifications,_())}catch{}}function _(){let t=document.getElementById(`notif-badge`),n=e.notifications.filter(e=>!e.dismissed).length;n>0?(t.textContent=n>99?`99+`:n,t.style.display=`flex`):t.style.display=`none`}function v(){e.notifInterval&&clearInterval(e.notifInterval),g(),e.notifInterval=setInterval(g,3e4)}async function y(e,t={}){return(await fetch(e,{credentials:`include`,...t,headers:{"Content-Type":`application/json`,...t.headers}})).json()}function b(){t(),document.getElementById(`theme-toggle`)?.addEventListener(`click`,n),document.querySelectorAll(`.nav-link`).forEach(e=>{e.addEventListener(`click`,t=>{t.preventDefault(),c(e.dataset.page)})}),document.getElementById(`user-btn`)?.addEventListener(`click`,()=>{let e=document.getElementById(`user-dropdown`);e.style.display=e.style.display===`none`?`block`:`none`}),document.getElementById(`logout-btn`)?.addEventListener(`click`,async()=>{await y(`/api/auth/logout`,{method:`POST`}),e.user=null,e.notifInterval&&clearInterval(e.notifInterval),a()}),document.getElementById(`change-password-btn`)?.addEventListener(`click`,()=>{document.getElementById(`user-dropdown`).style.display=`none`,document.getElementById(`password-modal`).style.display=`flex`}),document.getElementById(`password-cancel`)?.addEventListener(`click`,()=>{document.getElementById(`password-modal`).style.display=`none`,document.getElementById(`password-error`).textContent=``}),document.getElementById(`password-form`)?.addEventListener(`submit`,async e=>{e.preventDefault();let t=document.getElementById(`current-password`).value,n=document.getElementById(`new-password`).value,r=document.getElementById(`confirm-new-password`).value,i=document.getElementById(`password-error`);if(n!==r){i.textContent=`Passwords do not match`;return}if(n.length<8){i.textContent=`Password must be at least 8 characters`;return}try{let e=await y(`/api/auth/change-password`,{method:`POST`,body:JSON.stringify({current_password:t,new_password:n})});e.ok?(document.getElementById(`password-modal`).style.display=`none`,i.textContent=``,document.getElementById(`current-password`).value=``,document.getElementById(`new-password`).value=``,document.getElementById(`confirm-new-password`).value=``):i.textContent=e.error||`Failed to change password`}catch{i.textContent=`Connection error`}}),document.getElementById(`notif-btn`)?.addEventListener(`click`,()=>{let e=document.getElementById(`notif-dropdown`);e.style.display=e.style.display===`none`?`block`:`none`}),document.getElementById(`notif-clear`)?.addEventListener(`click`,async()=>{await y(`/api/notifications/clear`,{method:`POST`}),e.notifications=[],_(),document.getElementById(`notif-list`).innerHTML=`<div class="notif-empty">No notifications</div>`}),document.addEventListener(`click`,e=>{e.target.closest(`.user-menu`)||(document.getElementById(`user-dropdown`).style.display=`none`),!e.target.closest(`#notif-btn`)&&!e.target.closest(`#notif-dropdown`)&&(document.getElementById(`notif-dropdown`).style.display=`none`)}),window.addEventListener(`hashchange`,()=>{let[e,...t]=(window.location.hash.slice(1)||`home`).split(`/`);c(e,t.length?{name:t[0]}:{})}),i()}b();