import dotenv from 'dotenv';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

// 密钥优先从本机 .env.local 读取（不进 config.json，也不提交）
dotenv.config({ path: path.join(ROOT, '.env.local') });

function readConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    cfg = { port: 8787, llm: {}, kling: {} };
  }
  cfg.llm = cfg.llm || {};
  cfg.kling = cfg.kling || {};
  // 环境变量优先，config.json 里的值作为兜底
  cfg.llm.apiKey = process.env.DEEPSEEK_API_KEY || cfg.llm.apiKey || '';
  cfg.kling.accessKey = process.env.KLING_API_KEY || cfg.kling.accessKey || '';
  cfg.kling.secretKey = process.env.KLING_SECRET_KEY || cfg.kling.secretKey || '';
  // 视频通道可切换：zhipu | kling | pixverse（也可用环境变量 VIDEO_PROVIDER 临时覆盖）
  const rawProvider = String(process.env.VIDEO_PROVIDER || cfg.video?.provider || 'zhipu').toLowerCase();
  const provider = ['zhipu', 'kling', 'pixverse'].includes(rawProvider) ? rawProvider : 'zhipu';
  cfg.video = { provider };
  cfg.pixverse = {
    apiKey: process.env.PIXVERSE_API_KEY || '',
    model: 'v4.5',
    quality: '540p',
    aspectRatio: cfg.kling.aspectRatio || '16:9'
  };
  cfg.zhipu = {
    apiKey: process.env.ZHIPU_API_KEY || process.env.ZHIPUAI_API_KEY || '',
    model: process.env.ZHIPU_VIDEO_MODEL || 'cogvideox-flash',
    size: '1920x1080'
  };
  return cfg;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function demoImagePool() {
  try {
    return fs.readdirSync(path.join(ROOT, 'images'))
      .filter(f => /^showcase-\d+\.png$/i.test(f))
      .sort()
      .map(f => 'images/' + f);
  } catch {
    return ['images/showcase-03.png'];
  }
}
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// ---------- 本地兜底分镜（无 LLM 密钥时） ----------
const QILU_SCENES = [
  { name: '泰山', desc: '泰山之巅，云海翻涌，日出金光洒满山脊', light: '黄金时刻逆光', img: 'images/showcase-05.png', en: 'the summit of Mount Tai, a rolling sea of clouds, golden sunrise light spilling over the ridgeline' },
  { name: '黄河', desc: '黄河蜿蜒穿过广袤平原，河水映着落日余晖', light: '剪影逆光', img: 'images/showcase-02.png', en: 'the Yellow River winding across vast plains, its water reflecting the glow of the setting sun' },
  { name: '孔庙', desc: '曲阜孔庙，红墙黄瓦，银杏叶落在古老石碑旁', light: '柔光', img: 'images/showcase-07.png', en: 'the Confucius Temple in Qufu, red walls and golden tiles, ginkgo leaves falling beside ancient stone steles' },
  { name: '趵突泉', desc: '济南趵突泉，泉水清冽，垂柳拂过水面', light: '自然光', img: 'images/showcase-06.png', en: 'Baotu Spring in Jinan, crystal-clear spring water, willow branches brushing the surface' },
  { name: '蓬莱阁', desc: '蓬莱阁临海而立，云雾缭绕宛如仙境', light: '柔光', img: 'images/showcase-09.png', en: 'Penglai Pavilion standing by the sea, wrapped in drifting mist like a fairyland' },
  { name: '大明湖', desc: '大明湖波光粼粼，画舫缓行，远山如黛', light: '自然光', img: 'images/showcase-11.png', en: 'Daming Lake shimmering with light, a painted boat gliding slowly, distant hills dark as ink' },
  { name: '潍坊风筝', desc: '潍坊的天空，各式风筝迎风而起，线牵向远方', light: '黄金时刻逆光', img: 'images/showcase-12.png', en: 'the sky over Weifang, colorful kites rising into the wind, their strings reaching toward the horizon' },
  { name: '尼山', desc: '尼山圣境，孔子像静立，山色苍翠', light: '柔光', img: 'images/showcase-13.png', en: 'the sacred realm of Nishan, the statue of Confucius standing serene amid lush green mountains' }
];
const VOICEOVER = [
  '这片土地，藏着千年的故事。',
  '风从远方吹来，带着历史的回响。',
  '每一步，都是与过去的对话。',
  '山水之间，初心未改。',
  '黄河奔流，不舍昼夜。',
  '登高望远，方知天地之大。',
  '故事还在继续，一如这片生生不息的土地。',
  '镜头拉远，齐鲁大地尽收眼底。'
];

function splitSentences(story) {
  const kept = [];
  const safe = story.replace(/["“][^"”]*["”]/g, m => { kept.push(m); return '\u0002' + (kept.length - 1) + '\u0003'; });
  return safe.split(/[。！？!?\n]+/)
    .map(s => s.trim().replace(/\u0002(\d+)\u0003/g, (_, k) => kept[+k]))
    .filter(s => s.length > 3);
}

const CAM_EN = {
  '固定机位': 'static locked-off camera', '固定镜头': 'static locked-off camera',
  '推': 'slow push-in', '缓慢推进': 'slow push-in',
  '拉': 'slow pull-back', '缓慢拉远': 'slow pull-back',
  '摇': 'smooth pan', '横移跟随': 'smooth lateral tracking shot',
  '跟拍': 'tracking follow shot', '缓慢环绕': 'slow orbiting arc shot',
  '俯拍': 'high-angle aerial view', '仰拍': 'low-angle upward view'
};
const STYLE_EN = {
  '国风水墨动画': 'Chinese ink-wash animation style',
  '写实古风纪录片': 'realistic ancient-Chinese documentary style',
  '卡通国风动画': 'cartoon Chinese national-style animation'
};

function localStoryboard(story, shotCount, style) {
  const useStyle = style || STYLE_DEFAULT;
  const styleEn = STYLE_EN[useStyle] || STYLE_EN[STYLE_DEFAULT];
  const beats = splitSentences(story);
  const len = story.trim().length;
  let n = shotCount || (len < 30 ? 4 : len < 80 ? 5 : len < 150 ? 6 : len < 250 ? 7 : 8);
  n = Math.max(4, Math.min(8, n));
  const cams = ['固定机位', '推', '摇', '跟拍', '缓慢环绕', '拉'];
  const sizes = ['远景', '中景', '近景', '全景', '特写', '远景'];
  const emos = ['平静', '温暖', '忧伤', '紧张', '希望'];
  const titles = ['风起齐鲁', '山水初逢', '古韵回响', '泉涌心声', '云开见远', '鸢飞长空', '圣境凝望', '天地归一'];
  const actions = [
    '云雾缓缓流动，晨光渐次铺满山脊', '河水奔流不息，波光随落日闪烁',
    '银杏叶随风飘落，拂过古老石碑', '泉眼涌动，垂柳轻拂水面',
    '海雾升腾，楼阁若隐若现', '画舫缓行，湖面泛起层层涟漪',
    '风筝迎风而起，丝线牵向远方', '山色苍翠，孔子像静默矗立'
  ];
  const actionsEn = [
    'clouds drift slowly as morning light spreads across the ridgeline',
    'the river flows on, ripples glinting in the setting sun',
    'ginkgo leaves drift down in the wind, brushing the ancient steles',
    'spring water wells up while willow branches sweep the surface',
    'sea mist rises and the pavilion fades in and out of view',
    'a painted boat glides slowly, ripples spreading across the lake',
    'kites rise into the wind, strings reaching toward the horizon',
    'lush mountains stand quiet around the serene statue of Confucius'
  ];
  const shots = [];
  for (let i = 0; i < n; i++) {
    const scene = QILU_SCENES[i % QILU_SCENES.length];
    const beat = beats[i] || '';
    const emotion = emos[i % emos.length];
    const camera = cams[i % cams.length];
    const camEn = CAM_EN[camera] || 'static camera';
    const shotSize = sizes[i % sizes.length];
    const rhythm = i % 4 === 3 ? '停顿' : (i === 0 ? '慢' : '中');
    const duration = 4 + (i % 5);
    const dialogue = beat || VOICEOVER[i % VOICEOVER.length];
    const title = titles[i % titles.length];
    const action = actions[i % actions.length];
    const desc = `${scene.desc}。${beat ? '画面呼应：' + beat : '故事在齐鲁风光中缓缓推进。'}`;
    const videoPrompt = `${styleEn}, cinematic quality. ${camEn}. ${scene.en}; ${actionsEn[i % actionsEn.length]}. Smooth stable motion, elegant composition, ${duration} seconds, for Kling / Jimeng video generation.`;
    shots.push({
      shotIndex: i + 1, title, desc, action, dialogue, duration, camera, shotSize,
      angle: i % 5 === 4 ? '鸟瞰' : '平视', light: scene.light,
      emotion, rhythm, img: scene.img, assets: [scene.name], videoPrompt
    });
  }
  return { title: '齐鲁叙事短片', style: useStyle, shots };
}

// ---------- LLM 故事分析（OpenAI 兼容接口） ----------
const LLM_SYS = `你是专业影视分镜师，面向齐鲁风物国风动画短片。
请把用户的故事拆分成合理数量的镜头，控制总镜头数 4～8 个，每个镜头时长 4–8 秒。
【强制要求】只返回标准 JSON，不要任何前言、解释、Markdown，不要多余文字。
每个镜头字段：
shotIndex：镜头序号（数字）
title：镜头小标题
description：画面内容描述
action：画面里人物/景物动作
camera：运镜方式（推/拉/摇/跟拍/固定机位/缓慢环绕等）
duration：时长，单位秒（整数）
videoPrompt：专门给 AI 视频生成器的英文提示词，国风动画，电影质感，贴合齐鲁风物，画面流畅，镜头匹配，适合可灵、即梦接口。
输出结构：
{"shots":[{"shotIndex":1,"title":"","description":"","action":"","camera":"","duration":5,"videoPrompt":""}]}`;

const STYLE_DEFAULT = '国风水墨动画';

async function llmStoryboard(cfg, story, shotCount, style) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  const useStyle = style || STYLE_DEFAULT;
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: LLM_SYS },
          { role: 'user', content: `故事文本：\n${story}\n风格：${useStyle}` + (shotCount ? `\n（总镜头数请控制在约 ${shotCount} 个）` : '') }
        ],
        temperature: 0.8,
        response_format: { type: 'json_object' }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    let content = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.shots) || !parsed.shots.length) throw new Error('LLM 返回缺少 shots');
    const pool = demoImagePool();
    const sorted = parsed.shots.slice().sort((a, b) => (+a.shotIndex || 0) - (+b.shotIndex || 0));
    const shots = sorted.slice(0, 8).map((s, i) => ({
      shotIndex: +s.shotIndex || i + 1,
      title: String(s.title || ''),
      desc: String(s.description || s.desc || ''),
      action: String(s.action || ''),
      dialogue: String(s.dialogue || ''),
      duration: Math.max(4, Math.min(8, +s.duration || 5)),
      camera: s.camera || '固定机位', shotSize: s.shotSize || '中景',
      angle: s.angle || '平视', light: s.light || '自然光',
      emotion: s.emotion || '平静', rhythm: s.rhythm || '中',
      img: pool[i % pool.length], assets: [],
      videoPrompt: s.videoPrompt || ''
    }));
    while (shots.length < 4) shots.push({ ...shots[shots.length - 1], shotIndex: shots.length + 1, title: shots[shots.length - 1].title + '（续）' });
    return { title: parsed.title || '齐鲁风物短片', style: useStyle, shots };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 故事扩写（逐句扩写，原句由服务端原样拼接，保证不被改写） ----------
const EXPAND_SYS = `你是中文编剧。用户会给出一段故事，按“句/分句”编号列出，每条末尾可能是句号，也可能是逗号或分号。
你要为“每一条”写一小段扩写内容，插在该条之后。
硬性要求：
1. 只写新增的扩写内容，绝对不要重复、改写或引用原句。
2. 若该条以句号/问号/感叹号结尾：可写 1-2 句完整描写，40-80 字。
3. 若该条以逗号/分号结尾：必须写成“句中的插入成分”，要与后文连成通顺的一句话，不要以句号结尾、不要另起主语，10-30 字。
4. 补充环境与光线、动作与神态、心理与情绪，可含一句对白；不新增角色、不改变情节走向。
5. 输出 JSON：{"details": ["第1条后的扩写", "第2条后的扩写", ...]}，数组长度必须等于条数，顺序对应。`;

function splitStorySentences(text) {
  const hard = text.match(/[^。！？!?…\n]+[。！？!?…]*/g) || [];
  const out = [];
  for (const chunk of hard.map(s => s.trim()).filter(Boolean)) {
    // 短句不再细分；长句（超过 40 字）按逗号/分号再切，避免整段扩写都堆在段尾
    if (chunk.length <= 40) { out.push({ text: chunk, soft: false }); continue; }
    const parts = chunk.match(/[^，,；;]+[，,；;]*/g) || [chunk];
    parts.forEach((p, idx) => {
      const t = p.trim();
      if (!t) return;
      out.push({ text: t, soft: idx < parts.length - 1 });
    });
  }
  return out;
}

// 把逗号处的插入语裁到 15-30 字，避免整篇被拉长十几倍
function clampSoftInsert(raw) {
  const d = String(raw || '').replace(/[。！？!?]+$/, '');
  if (!d) return '';
  const parts = d.split('，').filter(Boolean);
  let out = '';
  for (const p of parts) {
    if (out && (out.length + 1 + p.length) > 30) break;
    out = out ? out + '，' + p : p;
    if (out.length >= 15) break;
  }
  if (!out) out = d.slice(0, 24);
  return out + '，';
}

async function llmExpand(cfg, story) {
  const segments = splitStorySentences(story);
  if (!segments.length) throw new Error('原文为空');
  const sentences = segments.map(s => s.text);
  const numbered = segments.map((s, i) => (i + 1) + '. ' + s.text).join('\n');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: EXPAND_SYS },
          { role: 'user', content: `原文共 ${sentences.length} 句：\n${numbered}` }
        ],
        temperature: 0.9,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        response_format: { type: 'json_object' }
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('LLM HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const data = await res.json();
    const content = (data.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(content);
    const details = Array.isArray(parsed.details) ? parsed.details : [];
    // 原句逐句原样拼接，模型只负责中间的扩写；逗号后的插入语限制在 15-30 字，且不以句号结尾
    const text = segments.map((seg, i) => {
      const d = details[i] ? String(details[i]).trim() : '';
      if (!seg.soft) return seg.text + d;
      return seg.text + clampSoftInsert(d);
    }).join('');
    if (text.length <= story.length) throw new Error('大模型未返回有效扩写');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 可灵 Kling（两种鉴权：API Key 直连 / AccessKey+SecretKey 的 JWT） ----------
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

function klingHeaders(cfg) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA };
  // 只填了 accessKey（api-key-kling-... 这种）：直接当 Bearer API Key 用；
  // 同时填了 secretKey：走官方 JWT 鉴权。
  headers.Authorization = 'Bearer ' + (cfg.secretKey ? klingJwt(cfg) : cfg.accessKey);
  return headers;
}

function klingError(prefix, data, status) {
  const code = data && data.code;
  const msg = (data && data.message) || status;
  if (code === 1102) return new Error(prefix + ': 可灵账户余额不足（code 1102），请先充值');
  return new Error(prefix + ': ' + msg + (code !== undefined ? '（code ' + code + '）' : ''));
}

function klingJwt(cfg) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ iss: cfg.accessKey, exp: now + 1800, nbf: now - 5 });
  const input = head + '.' + payload;
  const sig = crypto.createHmac('sha256', cfg.secretKey).update(input).digest('base64url');
  return input + '.' + sig;
}

async function klingSubmit(cfg, prompt, duration) {
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/v1/videos/text2video', {
    method: 'POST',
    headers: klingHeaders(cfg),
    body: JSON.stringify({
      model_name: cfg.model || 'kling-v2-1',
      prompt: String(prompt).slice(0, 2500),
      cfg_scale: 0.5,
      mode: cfg.mode || 'std',
      duration: String(duration || cfg.duration || '5'),
      aspect_ratio: cfg.aspectRatio || '16:9'
    })
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw klingError('可灵提交失败', data, res.status);
  return data.data.task_id;
}

async function klingQuery(cfg, taskId) {
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/v1/videos/text2video/' + encodeURIComponent(taskId), {
    headers: klingHeaders(cfg)
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw klingError('可灵查询失败', data, res.status);
  const d = data.data;
  const status = d.task_status;
  const videoUrl = d.task_result?.videos?.[0]?.url || null;
  return {
    status: status === 'succeed' ? 'succeed' : status === 'failed' ? 'failed' : 'processing',
    raw: status, videoUrl, message: d.task_status_msg || ''
  };
}

async function klingImageSubmit(cfg, prompt) {
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/v1/images/generations', {
    method: 'POST',
    headers: klingHeaders(cfg),
    body: JSON.stringify({
      model_name: cfg.imageModel || 'kling-v2-1',
      prompt: String(prompt).slice(0, 2500),
      negative_prompt: '模糊，变形，低质量，水印，文字',
      cfg_scale: 0.5,
      aspect_ratio: cfg.aspectRatio || '16:9',
      n: 1
    })
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw klingError('可灵生图提交失败', data, res.status);
  return data.data.task_id;
}

async function klingImageQuery(cfg, taskId) {
  const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/v1/images/generations/' + encodeURIComponent(taskId), {
    headers: klingHeaders(cfg)
  });
  const data = await res.json();
  if (!res.ok || data.code !== 0) throw klingError('可灵生图查询失败', data, res.status);
  const d = data.data;
  const status = d.task_status;
  const imageUrl = d.task_result?.images?.[0]?.url || null;
  return {
    status: status === 'succeed' ? 'succeed' : status === 'failed' ? 'failed' : 'processing',
    raw: status, imageUrl, message: d.task_status_msg || ''
  };
}

// ---------- PixVerse（OpenAPI v2，API-KEY 鉴权） ----------
const PIXVERSE_BASE = 'https://app-api.pixverse.ai/openapi/v2';

function pixverseHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_UA,
    'API-KEY': cfg.apiKey,
    'Ai-trace-id': crypto.randomUUID()
  };
}

function pixverseError(prefix, data) {
  const code = data && data.ErrCode;
  if (code === 500090) return new Error(prefix + ': PixVerse 额度不足，请先充值');
  if (code === 10005) return new Error(prefix + ': PixVerse 密钥无效（apiKey is not registered）');
  return new Error(prefix + ': ' + ((data && (data.ErrMsg || data.Error?.Message)) || 'unknown') + (code !== undefined ? '（ErrCode ' + code + '）' : ''));
}

async function pixverseSubmit(cfg, prompt, duration) {
  const res = await fetch(PIXVERSE_BASE + '/video/text/generate', {
    method: 'POST',
    headers: pixverseHeaders(cfg),
    body: JSON.stringify({
      aspect_ratio: cfg.aspectRatio || '16:9',
      duration: +duration >= 8 ? 8 : 5,
      model: cfg.model || 'v4.5',
      prompt: String(prompt).slice(0, 2000),
      quality: cfg.quality || '540p',
      water_mark: false,
      seed: 0
    })
  });
  const data = await res.json();
  if (data.ErrCode !== 0) throw pixverseError('PixVerse 提交失败', data);
  const id = data.Resp && data.Resp.video_id;
  if (!id) throw new Error('PixVerse 未返回 video_id');
  return 'pv-' + id;
}

async function pixverseQuery(cfg, taskId) {
  const res = await fetch(PIXVERSE_BASE + '/video/result/' + encodeURIComponent(taskId), {
    headers: pixverseHeaders(cfg)
  });
  const data = await res.json();
  if (data.ErrCode !== 0) throw pixverseError('PixVerse 查询失败', data);
  const d = data.Resp || {};
  const st = +d.status;
  // PixVerse 状态码：1 成功 / 5 处理中 / 7 审核未通过 / 8 生成失败
  return {
    status: st === 1 ? 'succeed' : (st === 7 || st === 8) ? 'failed' : 'processing',
    raw: st,
    videoUrl: d.url || null,
    message: st === 7 ? '内容审核未通过' : st === 8 ? '生成失败' : ''
  };
}

// ---------- 智谱 BigModel（cogvideox-flash 免费视频模型） ----------
const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4';

function zhipuHeaders(cfg) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': BROWSER_UA,
    Authorization: 'Bearer ' + cfg.apiKey
  };
}

function zhipuError(prefix, data, status) {
  const msg = data?.error?.message || data?.msg || data?.message || status;
  const code = data?.error?.code || data?.code;
  return new Error(prefix + ': ' + msg + (code ? '（' + code + '）' : ''));
}

async function zhipuSubmit(cfg, prompt) {
  const res = await fetch(ZHIPU_BASE + '/videos/generations', {
    method: 'POST',
    headers: zhipuHeaders(cfg),
    body: JSON.stringify({
      model: cfg.model || 'cogvideox-flash',
      prompt: String(prompt).slice(0, 1500),
      with_audio: false,
      size: cfg.size || '1920x1080',
      fps: 30
    })
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw zhipuError('智谱提交失败', data, res.status);
  return 'zp-' + data.id;
}

// CogView-3-Flash 免费生图（同步返回图片地址）
async function zhipuImage(cfg, prompt) {
  const res = await fetch(ZHIPU_BASE + '/images/generations', {
    method: 'POST',
    headers: zhipuHeaders(cfg),
    body: JSON.stringify({
      model: 'cogview-3-flash',
      prompt: String(prompt).slice(0, 1000),
      size: '1024x1024'
    })
  });
  const data = await res.json();
  if (!res.ok || !data.data?.[0]?.url) throw zhipuError('智谱生图失败', data, res.status);
  return data.data[0].url;
}

async function zhipuQuery(cfg, taskId) {
  const res = await fetch(ZHIPU_BASE + '/async-result/' + encodeURIComponent(taskId), {
    headers: zhipuHeaders(cfg)
  });
  const data = await res.json();
  if (!res.ok) throw zhipuError('智谱查询失败', data, res.status);
  const st = String(data.task_status || '').toUpperCase();
  return {
    status: st === 'SUCCESS' ? 'succeed' : st === 'FAIL' ? 'failed' : 'processing',
    raw: st,
    videoUrl: data.video_result?.[0]?.url || null,
    coverUrl: data.video_result?.[0]?.cover_image_url || null,
    message: st === 'FAIL' ? (data.fail_reason || '生成失败') : ''
  };
}

// ---------- 演示任务存储 ----------
const demoTasks = new Map();
const demoImageTasks = new Map();

// ---------- HTTP 工具 ----------
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  const cfg = readConfig();
  const llmOn = !!(cfg.llm && cfg.llm.apiKey);
  const klingOn = !!(cfg.kling && cfg.kling.accessKey);
  const pixverseOn = !!(cfg.pixverse && cfg.pixverse.apiKey);
  const zhipuOn = !!(cfg.zhipu && cfg.zhipu.apiKey);
  const provider = cfg.video.provider;
  const videoOn = provider === 'pixverse' ? pixverseOn : provider === 'zhipu' ? zhipuOn : klingOn;

  if (pathname === '/api/config-status') {
    return sendJson(res, {
      mode: videoOn ? 'real' : 'demo',
      provider,
      llmConfigured: llmOn,
      klingConfigured: klingOn,
      pixverseConfigured: pixverseOn,
      zhipuConfigured: zhipuOn,
      llmModel: cfg.llm?.model || '',
      demoImages: demoImagePool()
    });
  }

  if (pathname === '/api/storyboard' && req.method === 'POST') {
    const body = await readBody(req);
    const story = String(body.story || '').trim();
    if (!story) return sendJson(res, { error: '请先输入故事' }, 400);
    const shotCount = body.shotCount ? Math.max(4, Math.min(8, +body.shotCount)) : null;
    const style = String(body.style || '').trim();
    if (llmOn) {
      try {
        const result = await llmStoryboard(cfg.llm, story, shotCount, style);
        return sendJson(res, { source: 'llm', ...result });
      } catch (e) {
        const fallback = localStoryboard(story, shotCount, style);
        return sendJson(res, { source: 'local-fallback', llmError: String(e.message || e), ...fallback });
      }
    }
    return sendJson(res, { source: 'local', ...localStoryboard(story, shotCount, style) });
  }

  if (pathname === '/api/expand' && req.method === 'POST') {
    const body = await readBody(req);
    const story = String(body.story || '').trim();
    if (!story) return sendJson(res, { error: '请先输入故事内容，再进行 AI 扩写' }, 400);
    if (!llmOn) return sendJson(res, { error: '未配置大模型密钥，无法扩写' }, 400);
    try {
      const text = await llmExpand(cfg.llm, story);
      return sendJson(res, { source: 'llm', text });
    } catch (e) {
      return sendJson(res, { error: '扩写失败：' + String(e.message || e) }, 502);
    }
  }

  if (pathname === '/api/video' && req.method === 'POST') {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return sendJson(res, { error: '缺少提示词' }, 400);
    if (videoOn) {
      try {
        const taskId = provider === 'pixverse'
          ? await pixverseSubmit(cfg.pixverse, prompt, body.duration)
          : provider === 'zhipu'
            ? await zhipuSubmit(cfg.zhipu, prompt)
            : await klingSubmit(cfg.kling, prompt, body.duration);
        return sendJson(res, { mode: 'real', provider, taskId, status: 'processing' });
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 502);
      }
    }
    const taskId = 'demo-' + crypto.randomBytes(6).toString('hex');
    const demoImage = pick(demoImagePool());
    demoTasks.set(taskId, { demoImage });
    return sendJson(res, { mode: 'demo', taskId, status: 'succeed', demoImage });
  }

  const videoMatch = pathname.match(/^\/api\/video\/(.+)$/);
  if (videoMatch && req.method === 'GET') {
    const taskId = decodeURIComponent(videoMatch[1]);
    if (taskId.startsWith('demo-')) {
      const t = demoTasks.get(taskId);
      return sendJson(res, { mode: 'demo', status: 'succeed', demoImage: t ? t.demoImage : pick(demoImagePool()) });
    }
    if (taskId.startsWith('zp-')) {
      if (!zhipuOn) return sendJson(res, { error: '未配置智谱密钥' }, 400);
      try {
        const r = await zhipuQuery(cfg.zhipu, taskId.slice(3));
        return sendJson(res, { mode: 'real', provider: 'zhipu', ...r });
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 502);
      }
    }
    if (taskId.startsWith('pv-')) {
      if (!pixverseOn) return sendJson(res, { error: '未配置 PixVerse 密钥' }, 400);
      try {
        const r = await pixverseQuery(cfg.pixverse, taskId.slice(3));
        return sendJson(res, { mode: 'real', provider: 'pixverse', ...r });
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 502);
      }
    }
    if (!klingOn) return sendJson(res, { error: '未配置可灵密钥' }, 400);
    try {
      const r = await klingQuery(cfg.kling, taskId);
      return sendJson(res, { mode: 'real', provider: 'kling', ...r });
    } catch (e) {
      return sendJson(res, { error: String(e.message || e) }, 502);
    }
  }

  if (pathname === '/api/image' && req.method === 'POST') {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return sendJson(res, { error: '缺少提示词' }, 400);
    // 智谱通道用免费的 CogView-3-Flash 生图，直接同步返回图片地址
    if (provider === 'zhipu' && zhipuOn) {
      try {
        const imageUrl = await zhipuImage(cfg.zhipu, prompt);
        return sendJson(res, { mode: 'real', provider: 'zhipu', status: 'succeed', imageUrl });
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 502);
      }
    }
    if (klingOn) {
      try {
        const taskId = await klingImageSubmit(cfg.kling, prompt);
        return sendJson(res, { mode: 'real', taskId, status: 'processing' });
      } catch (e) {
        return sendJson(res, { error: String(e.message || e) }, 502);
      }
    }
    const taskId = 'demoimg-' + crypto.randomBytes(6).toString('hex');
    const demoImage = pick(demoImagePool());
    demoImageTasks.set(taskId, { demoImage });
    return sendJson(res, { mode: 'demo', taskId, status: 'succeed', demoImage });
  }

  const imageMatch = pathname.match(/^\/api\/image\/(.+)$/);
  if (imageMatch && req.method === 'GET') {
    const taskId = decodeURIComponent(imageMatch[1]);
    if (taskId.startsWith('demoimg-')) {
      const t = demoImageTasks.get(taskId);
      return sendJson(res, { mode: 'demo', status: 'succeed', demoImage: t ? t.demoImage : pick(demoImagePool()) });
    }
    if (!klingOn) return sendJson(res, { error: '未配置可灵密钥' }, 400);
    try {
      const r = await klingImageQuery(cfg.kling, taskId);
      return sendJson(res, { mode: 'real', ...r });
    } catch (e) {
      return sendJson(res, { error: String(e.message || e) }, 502);
    }
  }

  return sendJson(res, { error: 'not found' }, 404);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  // 只对外提供前端资源：隐藏文件、环境变量、日志、脚本、服务器配置一律不放行
  const segs = rel.split('/').filter(Boolean);
  const first = (segs[0] || '').toLowerCase();
  const blocked =
    segs.some(s => s.startsWith('.')) ||
    /\.(log|ps1|env|md|py|json)$/i.test(rel) && !/^\/images\//i.test(rel) ||
    ['server.js', 'node_modules', 'dev', 'docs', 'dist', 'vibe_images', 'media'].includes(first);
  if (blocked) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---- 访问口令：设置环境变量 ACCESS_CODE 后整个站点需要口令 ----
const ACCESS_CODE = String(process.env.ACCESS_CODE || '').trim();
const PASS_COOKIE = 'yjxl_pass';
const passToken = (code) => crypto.createHash('sha256').update('yjxl-pass:' + code).digest('hex');

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function gateHtml(msg) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>一镜叙鲁 · 访问验证</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0f16;color:#e8e8f0;
font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.box{width:min(360px,88vw);background:#171722;border:1px solid #262636;border-radius:14px;padding:28px}
h1{font-size:17px;margin:0 0 6px;font-weight:600}
p{font-size:13px;color:#8b8ba0;margin:0 0 18px}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid #2a2a3c;background:#0f0f16;
color:#e8e8f0;font-size:14px;outline:none}
input:focus{border-color:#6c5ce7}
button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:9px;background:#6c5ce7;
color:#fff;font-size:14px;cursor:pointer}
button:hover{background:#5a4bd4}
.err{color:#ff6b6b;font-size:12px;margin-top:10px;min-height:16px}
</style></head><body>
<div class="box">
<h1>一镜叙鲁</h1>
<p>请输入访问口令</p>
<input id="c" type="password" placeholder="访问口令" autofocus
 onkeydown="if(event.key==='Enter')go()">
<button onclick="go()">进入工作台</button>
<div class="err">${msg}</div>
</div>
<script>function go(){location.href='/__gate?code='+encodeURIComponent(document.getElementById('c').value)}</script>
</body></html>`;
}

// 返回 true 表示请求已被拦截
function checkGate(req, res, pathname) {
  if (!ACCESS_CODE) return false;
  const url = new URL(req.url, 'http://localhost');
  if (pathname === '/__gate') {
    const code = (url.searchParams.get('code') || '').trim();
    if (code && code === ACCESS_CODE) {
      res.writeHead(302, {
        'Set-Cookie': PASS_COOKIE + '=' + passToken(ACCESS_CODE) + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax',
        'Location': '/app.html'
      });
      res.end();
      return true;
    }
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gateHtml(code ? '口令不正确，请重试' : ''));
    return true;
  }
  if (readCookie(req, PASS_COOKIE) === passToken(ACCESS_CODE)) return false;
  if (pathname.startsWith('/api/')) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: '需要访问口令，请先打开首页输入口令' }));
    return true;
  }
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(gateHtml(''));
  return true;
}

const server = http.createServer(async (req, res) => {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  // 云端同源子路径 /functions/v1/app/* 在本地映射到既有 /api/* 逻辑
  const FN_PREFIX = '/functions/v1/app';
  if (pathname === FN_PREFIX || pathname.startsWith(FN_PREFIX + '/')) {
    pathname = '/api' + pathname.slice(FN_PREFIX.length);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }
  if (checkGate(req, res, pathname)) return;
  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    return serveStatic(req, res, pathname);
  } catch (e) {
    return sendJson(res, { error: String(e.message || e) }, 500);
  }
});

// 云端部署时平台会注入 PORT；本地默认 8787
const PORT = Number(process.env.PORT) || readConfig().port || 8787;
server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  一镜叙鲁 服务已启动');
  console.log('  工作台:  http://localhost:' + PORT + '/app.html');
  console.log('  首页:    http://localhost:' + PORT + '/');
  console.log('  密钥来源: 环境变量 / .env.local（留空=演示模式）');
  console.log('==============================================');
});
