# MediaMTX Player SDK v1.0 开发文档

## 1. 简介
本 SDK 是一套轻量级的前端解决方案，专为配合 MediaMTX 服务的 WebRTC WHEP 接口和 Simulcast 功能设计。它包含以下核心组件：
1.  **`MediaMTXWebRTCReader`**: 负责 WHEP 协议交互、WebRTC 连接建立、RTP 接收和 SDP 协商。
2.  **`ABREngine`**: 自适应码率（ABR）控制引擎，负责监控网络状态并自动切换视频层级。
3.  **`MMXControlClient`** (内部): 负责 WebSocket 信令通道，与服务端进行层级切换通信。
4.  **`TimeSync`**: 向 ppcenter 做应用层时钟校准，供端到端延迟（P2P Delay）计算使用。可选组件，不影响播放。
5.  **`codec-capability.js`**: HEVC/H264 多轨同播的浏览器解码能力检测，决定连接 `.../h264/whep` 还是 `.../hevc/whep`。可选组件；未引入时固定请求 H264。详见 §7。

---

## 2. 快速集成

### 2.1 引入文件

本 SDK 使用 **ES module**。`main.js` 是入口，其余模块由它 `import`，HTML 里只需引入这一个：

```html
<script type="module" src="main.js"></script>
```

> 注意：ES module 必须经 HTTP(S) 提供，直接双击打开 `file://` 会被浏览器的 CORS 策略拒绝。

若只需要某个组件而不用整个页面，按需 import 即可：

```javascript
import { MediaMTXWebRTCReader, MMXControlClient } from './ppplayer.mjs';
import { ABREngine } from './abr-engine.mjs';
```

**文件清单**

| 文件 | 作用 |
| :--- | :--- |
| `main.js` | 入口：UI 绑定、播放流程编排 |
| `ppplayer.mjs` | `MediaMTXWebRTCReader` + `MMXControlClient` |
| `abr-engine.mjs` | ABR 引擎 |
| `time-sync.mjs` | 时钟校准（§6） |
| `obs-timestamp.mjs` | 端到端延迟计算（§6） |
| `sei-timestamp.mjs` | 码流内 SEI 时间戳解析（Chromium） |
| `codec-capability.mjs` | HEVC/H264 能力检测（§7） |
| `buffer-config.mjs` | 播放缓冲时长（§9） |
| `play-request.mjs` | 向 ppcenter 请求播放决策（§10） |
| `nat-probe.mjs` | NAT 类型探测（§10） |
| `playback-paths.mjs` | Edge / P2P 两条播放路径（§10） |
| `playback-race-controller.mjs` | 竞速状态机（§10） |
| `play-decision-runner.mjs` | 按决策组装竞速（§10） |

**测试**：`npm test`（`node --test test/*.test.mjs`，共 59 个用例）。

### 2.2 基础示例 (Main.js)
```javascript
// 1. 实例化 ABR 引擎
const abrEngine = new ABREngine({
    // 当 ABR 决策需要切换时回调
    onSwitchLayer: (trackId, reason) => {
        if (controlClient) {
            console.log(`切换到 Track: ${trackId}, 原因: ${reason}`);
            controlClient.selectLayer(trackId, reason);
        }
    }
});

// 2. 实例化播放器
const reader = new MediaMTXWebRTCReader({
    url: 'http://localhost:8899/live/stream/whep',
    maxBitrate: 2500, // 初始带宽限制 (可选)
    
    // WebRTC Track 回调
    onTrack: (evt) => {
        const videoEl = document.getElementById('video');
        if (videoEl.srcObject !== evt.streams[0]) {
            videoEl.srcObject = evt.streams[0];
        }
    },
    
    // WHEP 连接成功回调 (拿到 SessionID 后)
    onConnected: () => {
        initControlClient(reader.sessionId);
    },
    
    onError: (err) => console.error("播放错误:", err)
});

// 3. 初始化控制信令 (WebSocket)
function initControlClient(sessionId) {
    const wsUrl = "http://localhost:8899/live/stream/whep"; // WHEP URL
    controlClient = new MMXControlClient(wsUrl, sessionId, {
        onConnected: () => console.log("信令连接成功"),
        onTracksInfo: (tracks, activeId) => {
            // 将 Track 信息注入 ABR 引擎
            abrEngine.setTracks(tracks, activeId);
        },
        onLayerSwitched: (id) => {
            // 通知 ABR 引擎切换完成
            abrEngine.notifyLayerSwitched(id);
        }
    });
}

// 4. 周期性驱动 ABR (建议 1s - 3s 一次)
setInterval(async () => {
    const stats = await reader.pc.getStats();
    // ... 计算 kbps 和 fps ...
    abrEngine.update(videoKbps, audioKbps, fps);
}, 1000);
```

---

## 3. API 接口说明

### 3.1 MediaMTXWebRTCReader (核心播放器)

#### 构造函数
`new MediaMTXWebRTCReader(config)`

**config 参数对象:**
| 属性 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `url` | String | 是 | 完整的 WHEP URL，例如 `http://host:port/live/stream/whep` |
| `maxBitrate` | Number | 否 | 初始连接时的最大带宽限制 (kbps)。用于 SDP `b=AS`。 |
| `user` | String | 否 | Basic Auth 用户名 |
| `pass` | String | 否 | Basic Auth 密码 |
| `token` | String | 否 | Bearer Token |
| `onTrack` | Function | 否 | 回调：`(RTCTrackEvent) => void`。当收到媒体轨道时触发。 |
| `onConnected` | Function | 否 | 回调：`() => void`。当 WHEP 握手完成并获得 SessionID 后触发。 |
| `onError` | Function | 否 | 回调：`(String) => void`。发生错误时触发。 |

#### 属性
| 属性名 | 类型 | 说明 |
| :--- | :--- | :--- |
| `sessionId` | String | WHEP 会话 ID，用于建立 WebSocket 连接。只读。 |
| `pc` | RTCPeerConnection | 底层的 WebRTC 连接对象。 |

#### 方法
| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `close()` | 无 | 关闭连接并清理资源。 |

---

### 3.2 MMXControlClient (WebSocket 信令)

#### 构造函数
`new MMXControlClient(whepUrl, sessionId, callbacks)`

| 参数 | 类型 | 说明 |
| :--- | :--- | :--- |
| `whepUrl` | String | WHEP URL，用于自动解析 WebSocket 地址和路径。 |
| `sessionId` | String | 从 Reader 获取的 Session ID。 |
| `callbacks` | Object | 回调函数集合 (见下表)。 |

**callbacks 参数对象:**
| 回调名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `onConnected` | - | WebSocket 连接成功。 |
| `onDisconnected` | - | WebSocket 连接断开。 |
| `onTracksInfo` | `(tracks: Array, activeId: Number)` | 收到服务端下发的流列表 (Tracks Manifest)。 |
| `onLayerSwitched` | `(currentId: Number)` | 服务端确认切换完成。 |

#### 方法
| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `selectLayer(trackId, reason)` | `trackId`: Number, `reason`: String | 发送切换指令给服务端。 |
| `close()` | - | 关闭 WebSocket 连接。 |

---

### 3.3 ABREngine (自适应码率引擎)

#### 构造函数
`new ABREngine(callbacks)`

**callbacks 参数对象:**
| 回调名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `onSwitchLayer` | `(trackId: Number, reason: String)` | 当 ABR 算法决定需要切换时触发。需在此回调中调用 `controlClient.selectLayer`。 |

#### 方法
| 方法名 | 参数 | 说明 |
| :--- | :--- | :--- |
| `setTracks(tracks, activeId)` | `tracks`: Array, `activeId`: Number | 初始化引擎。传入从 WebSocket 获取的 track 列表。 |
| `update(videoKbps, audioKbps, fps)` | `videoKbps`: Number (kbps)<br>`audioKbps`: Number (kbps)<br>`fps`: Number | **核心驱动方法**。需由外部定时器调用，传入实时统计数据。 |
| `notifyLayerSwitched(trackId)` | `trackId`: Number | 通知引擎切换已完成（重置内部冷却计时器）。 |
| `notifyManualSwitch(trackId)` | `trackId`: Number | 通知引擎用户进行了手动切换（将自动关闭 Auto 模式）。 |
| `setAutoMode(enabled)` | `enabled`: Boolean | 开启/关闭自动 ABR 模式。 |

---

## 4. 数据结构定义

### Track Info 对象
由服务端通过 WebSocket 的 `TRACKS_INFO` 消息下发。
```javascript
{
    "id": 0,            // Track ID (唯一标识)
    "type": "video",    // "video" | "audio"
    "codec": "h264",    // "h264" | "hevc" | "opus"
    "bitrate": 2500000, // 目标码率 (bps)
    "width": 1920,      // (Video Only)
    "height": 1080      // (Video Only)
}
```

---

## 5. ABR 逻辑说明 (内置策略)

**ABREngine** 采用保守降级、探测升级策略：

1.  **降级 (Downgrade)**:
    *   **触发条件**: `AvgFPS < 12` (严重卡顿) 或 `Bandwidth < Target * 0.5` (严重拥塞)。
    *   **防抖**: 需连续 **3次** `update` 均满足条件才触发切换。
    *   **Audio Only**: 仅当 FPS < 10 或 带宽极低 (< 200kbps) 时才降级至纯音频。

2.  **升级 (Upgrade)**:
    *   **触发条件**: `AvgFPS >= 25` (流畅) 且 `Bandwidth >= Target * 0.95` (带宽充裕)。
    *   **防抖**: 需连续 **3次** `update` 均满足条件。

3.  **起播保护**:
    *   引擎初始化后的前 **5秒** 内不执行降级操作，以等待缓冲区填充和解码器稳定。

---

## 6. 时钟校准与端到端延迟 (TimeSync)

### 6.1 为什么需要

端到端延迟的算法是 `本地当前时间 - 推流端在该帧内嵌的时间戳`。内嵌时间戳来自 ppobs 经 NTP 校准的 UTC 时钟，因此**只有当播放端的时钟也对齐 UTC 时，这个减法才有意义**。

浏览器无法访问系统级 NTP（拿不到 UDP 123），直接用未校正的 `Date.now()` 会得到荒谬的结果：本地时钟走快就是负值，走慢就是超大正值（实测出现过 145 秒）。

解法是让播放端向 **ppcenter**（后端服务，自身运行 NTP）做一次应用层时钟偏移估算，用的是 NTP 内部的四时间戳算法：

```
offset = ((T2 - T1) + (T3 - T4)) / 2   ≈ ppcenter 时钟 - 本地时钟
校正后时间 = Date.now() + offset        // 是加不是减
```

每轮采样 6 次取 RTT 最小的一次（RTT 越小说明受排队抖动干扰越小），默认每 45 秒重新校准一次。

### 6.2 集成方式

ppcenter 地址与 WHEP URL 一样由手工输入，默认 `http://127.0.0.1:18000`。也支持 URL 参数：

```
index.html?url=<WHEP URL>&ppcenter=http://10.0.0.5:18000
```

代码中的用法：

```javascript
const timeSync = new TimeSync({ ppcenter: 'http://127.0.0.1:18000' });
timeSync.start().catch(e => console.warn('校准不可用:', e.message));

// 校准完成后才能算延迟
const now = timeSync.now();          // 未完成校准时返回 null
if (now !== null) {
    const delayMs = now - embeddedTimestamp;
}
```

**关键约定**：`now()` 在首次校准完成前返回 `null`，调用方必须把它当作"还不能算延迟"，**不要退化成裸的 `Date.now()`**——那正是本机制要消除的错误来源。

### 6.3 API

| 方法/属性 | 说明 |
| :--- | :--- |
| `new TimeSync({ppcenter, resyncIntervalMs, sampleCount, onStateChange})` | `ppcenter` 为基础 URL；其余可选。 |
| `start()` | 连接并执行首轮校准，返回 Promise&lt;Boolean&gt;。 |
| `now()` | 校正后的 UTC 毫秒；未校准时为 `null`。 |
| `isReady()` | 是否已完成至少一次校准。 |
| `reportLatency(path, delayMs)` | 上报延迟，`path` 取 `'edge'` 或 `'p2p'`。 |
| `stop()` | 停止校准并断开连接。 |
| `offsetMs` / `lastSyncRttMs` | 当前生效的偏移量与所取样本的 RTT，用于判断可信度。 |

未加载 `time-sync.js`、或 ppcenter 不可达时，播放不受影响，只是 P2P Delay 退回基于 RTT/jitter buffer 的估算值（显示为 `~N ms (est.)`）。

---

**视频秒开方案**
停止时，调用pause而不是exit。player客户端切换到 **Audio Only** (极低带宽占用，64kbps)状态。
重新恢复(resume)播放时，视频就是秒开。服务器会立即切换回视频源，并**立即发送一个关键帧IF**
- 方案优点
1.  **极速恢复**：因为 ICE 和 DTLS 根本没断，恢复耗时 = RTT (信令往返) + 0ms (建连)。
2.  **带宽极低**：暂停期间只有音频流量（64kbps），对于宽带几乎可以忽略。
3.  **实现简单**：不需要改动底层 WebRTC 握手逻辑，复用现有的 ABR 切换能力。

---

## 7. HEVC/H264 多轨同播 (codec-capability.js)

详细设计见 `docs/design/whip-hevc-h264-multitrack-simulcast-design.zh-CN.md`（ppcdn 仓库）。本节只说明 pplayer 侧的接入方式。

### 7.1 背景

ppobs 开启多轨同播后，会同时发布两条独立的 WHIP 会话：H264 和 HEVC，分别对应两个互不相关的 WHEP 地址：

```
http://edge:8889/{appId}/{stream}/h264/whep
http://edge:8889/{appId}/{stream}/hevc/whep
```

两条会话在服务端完全独立（各自的 PeerConnection、RTP 状态、ABR 分层），因此**编解码器的选择必须在建立 WHEP 连接之前一次性确定**，播放中途不能像 ABR 切分层那样切换 codec。

### 7.2 检测逻辑

`selectPlaybackCodec()` 按以下顺序判断浏览器是否支持解码 HEVC：

1. `navigator.mediaCapabilities.decodingInfo()`：向浏览器询问对 `hvc1.1.6.L93.B0`（HEVC Main Profile Level 3.1）在 WebRTC 场景下的解码能力。
2. 若上一步的 API 不存在或结果不确定，回退到 `RTCRtpReceiver.getCapabilities('video')`，检查是否列出了 `video/H265` 或 `video/HEVC`。
3. 两种方式都不确定（API 缺失、抛出异常、返回不支持）时，一律判定为不支持 HEVC，退回 H264。

检测结果在页面生命周期内缓存一次，不会每次开播都重新探测。

```javascript
const codecType = await selectPlaybackCodec(); // "hevc" | "h264"
```

### 7.3 main.js 的接入方式

`main.js` 在 `startStream()` 里，于建立 WHEP 连接**之前**完成 codec 选择，并把 codecType 作为 URL path segment 插入到 WHEP URL 中（插入位置固定在 `whep` 段之前，与设计文档 §3.1 一致）：

```
http://edge:8889/{appId}/{stream}/whep          →  .../{stream}/hevc/whep   (检测到支持 HEVC)
http://edge:8889/{appId}/{stream}/whep          →  .../{stream}/h264/whep  (不支持，或未加载 codec-capability.js)
```

若输入的 WHEP URL 本身已经带有 `/h264/whep` 或 `/hevc/whep`，则视为显式指定，跳过浏览器能力检测直接使用。也可以通过 URL 查询参数强制指定（等价于手工在 WHEP URL 里写死 codec 段）：

```
index.html?url=<WHEP URL>&codecType=hevc
```

### 7.4 协商失败降级

若选择了 HEVC 但 WHEP 建连失败，且失败原因看起来是 codec/SDP 协商问题（而不是普通网络错误），`main.js` 会在同一次 `startStream()` 调用内自动降级到 H264 重连一次；一次 `startStream()` 生命周期内最多降级一次，避免 HEVC/H264 来回反复重连。已经连接成功过的会话断线重连时，会按原 codec 重连，不做降级判断。

### 7.5 状态展示

播放开始后，`main.js` 会在页面右上角（`#playbackCodecLabel`，若 HTML 里没有该元素则自动创建一个悬浮标签）显示当前实际使用的 codec：

```
Playback codec: hevc
Playback codec: h264
```

同时在 console 输出 `[Main] Playback codec: ...` 日志。

### 7.6 SEI 时间戳解析的 HEVC 支持

`sei-timestamp.js` 的 `attachSeiTimestampReader(receiver, onTimestamp, codec)` 新增第三个参数 `codec`（`'h264'` 或 `'hevc'`，默认 `'h264'`）。HEVC 与 H264 的 NAL 头长度和 SEI NAL type 不同（HEVC 头 2 字节、SEI 类型为 39/40；H264 头 1 字节、SEI 类型为 6），但两者内嵌的 SEI payload 格式一致，因此只需要按 codec 切换 NAL 解析方式即可复用同一套时间戳提取逻辑。`main.js` 会自动传入当前会话选中的 codec，无需手动指定。

### 7.7 API

| 函数 | 说明 |
| :--- | :--- |
| `isHevcPlaybackSupported()` | 返回 `Promise<Boolean>`，是否检测到浏览器可解码 HEVC。结果按页面生命周期缓存。 |
| `selectPlaybackCodec()` | 返回 `Promise<String>`，`"hevc"` 或 `"h264"`。内部调用 `isHevcPlaybackSupported()`。 |

未加载 `codec-capability.js` 时，`main.js` 会打印警告并固定按 H264 处理，播放不受影响。

---

## 8. 截图与录像 (Snapshot / Record)

`index.html` 在控制栏提供两个按钮：📷 截图（`#snapshotBtn`）和 ⏺ 录像（`#recordBtn`），逻辑全部在 `main.js` 中，无需额外脚本。

### 8.1 截图

点击后用 `<canvas>` 抓取当前 `<video>` 帧（尺寸取 `video.videoWidth`/`videoHeight`），导出为 PNG 并触发浏览器下载，文件名 `snapshot-<timestamp>.png`。

### 8.2 录像

点击后用 `video.captureStream()` 拿到当前播放画面的 `MediaStream`，通过 `MediaRecorder` 录制为 WebM（优先 `vp9,opus`，其次 `vp8,opus`，均不支持时退回浏览器默认 `video/webm`）。

- **固定时长**：最长 **60 秒**，到时自动停止；也可以再次点击按钮提前停止。
- 录制中按钮会有红色脉冲动画提示，`title` 变为 `Stop Recording`。
- 停止后自动导出 `record-<timestamp>.webm` 并触发下载。

### 8.3 ABR 自动模式下禁用

截图和录像都要求画面锁定在某一个明确的层级：Auto (ABR) 模式下分辨率/码率随时可能切换，截出来的图或录出来的视频会跳变，因此**两个按钮在 `layerSelect` 处于 `Auto` 时禁用**（`disabled` 属性 + 半透明样式），只有用户手动选择了某个画质层级后才能使用。

- 若正在录像时用户切回 Auto 模式，录像会被立即强制停止并导出已录制的部分。
- 停止播放（`stopStream()`，即点击 Exit）会重置为 Auto 模式，因此也会连带停止一次进行中的录像。

依赖浏览器的 `HTMLMediaElement.captureStream()` 和 `MediaRecorder`；不支持这两个 API 的浏览器上，点击录像按钮不会有效果（`console.warn` 提示，不影响播放）。

---

## 9. 播放缓冲时长 (buffer-config.mjs)

播放缓冲（jitter buffer）决定浏览器在渲染前先缓存多少毫秒的媒体：**调大更抗抖动但延迟增加，调小延迟低但容易卡顿**。这是纯本地的播放端参数，不与服务端协商。

- 默认 200ms，可用范围 100~1000ms。
- URL 参数 `?bufferMs=300` 可预设，界面上的滑块可以实时覆盖（无需重启播放）。
- 底层优先用标准的 `RTCRtpReceiver.jitterBufferTarget`（毫秒），不支持时退回 Chrome 的 `playoutDelayHint`（秒）。两者都没有的浏览器保持自身的自适应缓冲，此时界面上的滑块会变灰。

```javascript
import { applyPlayoutBuffer, parseBufferMs, DEFAULT_BUFFER_MS } from './buffer-config.mjs';

// 返回实际生效的 API 名称，或 null（该浏览器不支持）
const applied = applyPlayoutBuffer(pc, 300);
```

---

## 10. P2P 加速与竞速 (§PLY-005/006)

启用后，播放器会**同时**发起两条连接并采用先出帧的那条：

- **Edge 路**：常规 WHEP，连到边缘节点。
- **P2P 路**：经 ppcenter 中转信令，直连推流端 ppobs。

### 10.1 为什么要竞速

NAT 穿透在公网上没有成功保证——对称型 NAT、运营商级 CGNAT 都会让直连失败。若串行地"先试 P2P、失败再连 Edge"，每一次穿透误判都要让观众多等几秒黑屏。竞速把这个代价降为 0：P2P 失败时 Edge 早已在并行建连。

判定以**首个可解码视频帧**为准（轮询 `inbound-rtp.framesDecoded > 0`），不是 ICE connected。

| 情况 | 行为 |
| :--- | :--- |
| P2P 先出帧 | 用 P2P，关闭尚未完成的 WHEP |
| Edge 先出帧 | 用 Edge，P2P 转入后台继续建连（默认至 2s 超时） |
| 后台 P2P 后来成功 | 仅在可平滑切换时才切（`canSwitchToP2P` 回调裁决），否则关闭 P2P |
| 选中路径中途失败 | 切到另一条；若 Edge 已被关闭则重新拉起 |
| 两条都失败 | 报错 |

### 10.2 启用方式

需要在 URL 上带齐五个参数（缺一不可，少给会直接报错而不是静默降级）：

```
index.html?ppcenter=http://center:18000&appId=xxx&streamName=live/s1&txTime=<hex>&txSecret=<hmac>
```

流程：播放器先做 NAT 探测并上报，再向 ppcenter `POST /v1/play/requests` 请求决策；ppcenter 返回 `edge-only`（只给 WHEP URL）或 `p2p-connect`（额外给 P2P 会话参数）。是否走 P2P 完全由服务端判定。

**不带这些参数时**，播放器直接使用输入框里的 WHEP URL，整套 P2P 代码不会执行——这是只做边缘播放的集成方式。

### 10.3 单独使用竞速控制器

`PlaybackRaceController` 不依赖 ppcenter，两条路径和时钟都可注入，可以独立使用：

```javascript
import { PlaybackRaceController } from './playback-race-controller.mjs';

const controller = new PlaybackRaceController({
    edgePath, p2pPath,          // 需实现 start({onFirstFrame,onFailed}) / stop()
    raceWindowMs: 500,
    connectTimeoutMs: 2000,
    onSelected: ({ path }) => console.log('选中', path),
    onFailed: (err) => console.error(err),
    onTelemetry: (e) => console.debug(e),
});
controller.start();
```
