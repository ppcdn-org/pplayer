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

// When the console opens this page as a popup it posts the login token in
// (see BrowserPublishPanel), so it never has to go through the URL/history.
// Announce readiness and accept the init message only from the configured
// parent origin.
const PARENT_ORIGIN = params.get('parent') || '';
window.addEventListener('message', (event) => {
  if (event.data?.type !== 'ppcdn-publish-init') return;
  if (PARENT_ORIGIN && event.origin !== PARENT_ORIGIN) return;
  if (event.data.token) $('token').value = event.data.token;
  if (event.data.ppcenter) $('ppcenter').value = event.data.ppcenter;
  if (event.data.appId) $('appId').value = event.data.appId;
  if (event.data.streamName) $('streamName').value = event.data.streamName;
  setStatus('已从控制台获取登录态');
});
if (window.opener) {
  window.opener.postMessage({ type: 'ppcdn-publish-ready' }, PARENT_ORIGIN || '*');
}

// Best-effort stop if the page is closed/hidden without clicking Stop, so a
// stale session doesn't linger (and, until it expired, block a restart). The
// server also supersedes a stale session on the same stream now, so this is
// cleanliness rather than correctness. keepalive lets the request outlive the
// page.
window.addEventListener('pagehide', () => {
  const config = publisher?.config;
  const sessionId = publisher?.decision?.sessionId;
  if (!config || !sessionId || publisher.stopped) return;
  try {
    const url = new URL(`/v1/publish/browser-requests/${encodeURIComponent(sessionId)}`, config.ppcenter);
    fetch(url, { method: 'DELETE', keepalive: true, headers: { Authorization: `Bearer ${config.token}` } });
  } catch {
    // Ignore - the page is going away.
  }
});

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
    simulcast: false,        // always a single stream
    seiTimestamps: true,     // always inject the absolute-timestamp SEI
    p2p: $('p2p').checked,
    onState: (state, detail) => setStatus(describe(state, detail), state === 'p2p-error' || state === 'nat-probe-failed'),
  });

  try {
    const decision = await publisher.start();
    $('preview').srcObject = publisher.stream;
    setStatus(`推流中：${decision.codec?.toUpperCase() || 'H264'} · session ${decision.sessionId}`
      + (decision.signal ? ' · P2P 已启用' : ''));
    $('switch').disabled = false;
    $('stop').disabled = false;
  } catch (error) {
    setStatus(`启动失败：${error?.code || error?.message || error}`, true);
    publisher = null;
    $('start').disabled = false;
  }
});

$('switch').addEventListener('click', async () => {
  if (!publisher) return;
  $('switch').disabled = true;
  try {
    if (await publisher.switchCamera()) {
      $('preview').srcObject = publisher.stream;
      setStatus(`已切换到${publisher.facingMode === 'user' ? '前置' : '后置'}摄像头`);
    }
  } catch (error) {
    setStatus(`切换摄像头失败：${error?.message || error}`, true);
  } finally {
    $('switch').disabled = false;
  }
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  $('switch').disabled = true;
  try {
    await publisher?.stop();
  } finally {
    publisher = null;
    $('preview').srcObject = null;
    $('start').disabled = false;
    setStatus('已停止');
  }
});
