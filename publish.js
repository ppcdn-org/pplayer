// Minimal browser publishing page. Wires the form to BrowserPublisher; all
// media/session logic lives in ppwebpublish.mjs (and p2p-answerer.mjs), so
// this file only owns the DOM.
import { BrowserPublisher } from './ppwebpublish.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// Prefill from query params so a link can open the page ready to publish:
//   publish.html?ppcenter=...&token=...&appId=...&streamName=...
$('ppcenter').value = params.get('ppcenter') || 'https://api.pp-cdn.org';
$('token').value = params.get('token') || '';
$('appId').value = params.get('appId') || '';
$('streamName').value = params.get('streamName') || '';

let publisher = null;

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.className = isError ? 'error' : '';
}

function describe(state, detail) {
  if (state === 'p2p' && detail?.type) return `p2p: ${detail.type}`;
  if (state === 'nat-probe') return '正在探测 NAT（P2P 需要）…';
  return state;
}

$('start').addEventListener('click', async () => {
  if (publisher) return;
  const token = $('token').value.trim();
  const appId = $('appId').value.trim();
  const streamName = $('streamName').value.trim();
  if (!token || !appId || !streamName) {
    setStatus('请填写 Token、appId 和 streamName', true);
    return;
  }

  $('start').disabled = true;
  setStatus('启动中…');
  publisher = new BrowserPublisher({
    ppcenter: $('ppcenter').value.trim(),
    token,
    appId,
    streamName,
    codec: $('codec').value === 'auto' ? null : $('codec').value,
    simulcast: $('simulcast').checked,
    seiTimestamps: $('sei').checked,
    p2p: $('p2p').checked,
    onState: (state, detail) => setStatus(describe(state, detail), state === 'p2p-error' || state === 'nat-probe-failed'),
  });

  try {
    const decision = await publisher.start();
    $('preview').srcObject = publisher.stream;
    setStatus(`推流中：${decision.codec?.toUpperCase() || 'H264'} · session ${decision.sessionId}`
      + (decision.signal ? ' · P2P 已启用' : ''));
    $('stop').disabled = false;
  } catch (error) {
    setStatus(`启动失败：${error?.code || error?.message || error}`, true);
    publisher = null;
    $('start').disabled = false;
  }
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  try {
    await publisher?.stop();
  } finally {
    publisher = null;
    $('preview').srcObject = null;
    $('start').disabled = false;
    setStatus('已停止');
  }
});
