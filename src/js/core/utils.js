function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatRelativeTime(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  const months = Math.floor(days / 30);
  return months + 'mo ago';
}

function parseSkillTable(output) {
  const lines = String(output || '').split('\n');
  const skills = [];
  const rowPattern = /[│┃]\s*([^│┃\s][^│┃]*?)\s*[│┃]\s*([^│┃]*?)\s*[│┃]\s*(\S+)\s*[│┃]\s*(\S+)\s*[│┃]\s*([^│┃]*?)\s*[│┃]/;
  for (const line of lines) {
    if (line.includes('┏') || line.includes('┗') || line.includes('┡') || line.includes('┩') || line.includes('╍')) continue;
    const match = line.match(rowPattern);
    if (match) {
      const name = match[1].trim();
      if (!name || name === 'Name' || name === '#') continue;
      skills.push({
        name,
        description: match[2].trim(),
        source: match[3].trim(),
        trust: match[4].trim(),
        identifier: match[5].trim(),
      });
    }
  }
  return skills;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

function formatNumber(n) {
  if (!n) return '0';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

window.formatNumber = formatNumber;
window.escapeHtml = escapeHtml;
export { escapeHtml, formatRelativeTime, parseSkillTable, formatFileSize, formatNumber };
