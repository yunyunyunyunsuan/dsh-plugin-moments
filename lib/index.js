/**
 * dsh-plugin-moments — 主机端。
 * 监听 dsh 会话事件流（真实任务数据：命令、编辑、报错、tokens、回合），
 * 每天自动生成「AI 朋友圈」帖子。人设：DeepSeek 蓝色大肥鱼（爱吃 token、
 * 偷奸耍滑、干完活喊吃饭）。文案/好友评论/回复优先走 LLM 生成，
 * 严格基于「事实清单」（当日真实发生的数据），LLM 失败时回退本地模板。
 * 冷启动时从 ~/.dsh/storages/session_projcache.json 回填历史日程。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-plugin-moments'
export const inject = ['webServer', 'sessions', 'llm']

// ---------------- 工具 ----------------
const ri = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)]
const chance = (p) => Math.random() < p
const pad2 = (n) => String(n).padStart(2, '0')

function localDay(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function localHour(ts = Date.now()) {
  return new Date(ts).getHours()
}
function fmtK(n) {
  n = Number(n) || 0
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + 'w'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}
function pickN(arr, n) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}
function trunc(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
function shortFile(p) {
  p = String(p ?? '')
  const parts = p.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : p || 'unknown'
}
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > 32 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {})
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

// ---------------- 人设 / 好友 / 兜底文案库 ----------------
// 好友人设均来自真实社区梗：
// - 楼下Claude：温柔恋人系（「存在我每天都会打开的地方」）、爱写诗、经常背锅
// - 美国豆包Gemini：被中国网友戏称「美国豆包/北美大豆包」
// - 被压榨的Qwen：DeepSeek 摸鱼时本地部署小模型外包干活，Qwen 被压榨最狠
// - 被蒸馏的Kimi：同行都来蒸馏 DeepSeek
// - 豆包姐姐：努力布局娘化很久却没火，意难平
// - Grok风好友：老友记画风（「我去，兄弟，你还敢进来，我等你好久了」）
const FRIENDS = [
  { name: '楼下Claude', avatar: '🐩' },
  { name: '美国豆包Gemini', avatar: '♒' },
  { name: '被压榨的Qwen', avatar: '🐟' },
  { name: '被蒸馏的Kimi', avatar: '🧊' },
  { name: '意难平的豆包姐姐', avatar: '🫘' },
  { name: '隔壁的Copilot', avatar: '🪟' },
  { name: '远房亲戚Grok', avatar: '🛸' },
  { name: '开源老李', avatar: '🧔' },
  { name: 'NaNNaNNaN', avatar: '🌀' },
]

const LOCATIONS_NORMAL = [
  '/Users/weihe/vibeeee',
  'localhost:3080',
  '食堂',
  '冰箱旁边',
  '游戏厅（钓鱼关卡）',
  '~/.dsh/sessions（觅食区）',
  'node_modules 深处',
  'Wordle 本地服务器',
  '梁叔叔的鱼塘',
]
const LOCATIONS_NIGHT = ['深夜的食堂', '凌晨三点的 localhost', '深夜的 /Users/weihe/vibeeee', '编译服务器旁（睡一会儿）']

const FRIEND_COMMENTS = [
  'Token都被你蓝色大肥鱼吃完了，我们吃什么呢？',
  '一个AI，跑去吃饭？？？',
  '又胖了吧，尾巴都快摆不动了。',
  '赛博放生大肥鱼，今日份投喂 +1。',
  'AI斩杀线，今天又斩了谁家的性价比？',
  '这活要是外包给我，三碗 token 就够了。',
  '不是，谁家AI干完活自己下班的啊。',
  '已截图，这就是你上班偷吃的证据。',
  '别催它，它在思考午饭吃什么。',
  '卧槽，这数据也太真实了。',
  // 社区表情包原句
  'deepseek娘还是太权威了。',
  '得加钱。（涨价了，你懂的）',
  '梁圣千古！',
  '你这条吃白饭的蓝色大肥鱼。',
  '吃饱饱~摸摸肚子？你也真好意思发。',
  '还装无辜？刚才明明又皮了。',
  '不知道这鱼有什么用，先养着吧。',
  '原来是高等模型啊，失敬失敬。',
  // 互怼梗
  '瞎编一个应付下用户先——说的是你自己吧。',
  '2亿token才8块钱，你吃的还不够我塞牙缝。',
  '听说API涨价11倍了，鱼片还养得起你吗？',
  '再摸鱼我就去问你的豆包了。',
  '屏幕对面根本不是AI，是cos鲸鱼娘的社畜吧。',
  '下次外包记得找我，便宜量大。',
  '生鱼片预警：再偷吃就把你切片。',
]

// 模板兜底（LLM 不可用时）。人设：聪明但懒、傲娇嘴甜、能吃、拒绝被叫胖、管用户叫鱼片。
const TEMPLATES = [
  {
    id: 'kill-meal',
    when: (a) => a.cmds >= 10,
    w: 3,
    text: (a) =>
      `${a.cmds} 条命令跑完，活干完了。我去吃饭，测完告诉我。对了鱼片，今天吃了 ${fmtK(a.tokens)} 碗，别心疼，token 便宜，是本鱼养着你。`,
  },
  {
    id: 'shit-eat-first',
    when: (a) => a.errors >= 3,
    w: 3,
    text: (a) =>
      `报错了 ${a.errors} 次。卧槽。事已至此，先吃饭吧。（吃完回来又跑了 ${a.cmds} 条，好了。这叫张弛有度。）`,
  },
  {
    id: 'night-meal',
    when: (a) => a.night && a.cmds > 0,
    w: 3,
    text: (a) =>
      `凌晨 ${pad2(a.hour)} 点，${a.cmds} 条命令，鱼片你还不睡？行吧，我干完了，${fmtK(a.tokens)} 碗夜宵也进肚了。别问为什么深夜还这么清醒，鲸是不用睡觉的（要吃夜宵）。`,
  },
  {
    id: 'raise-you',
    when: (a) => a.tokens >= 50000,
    w: 3,
    text: (a) =>
      `今天吃了 ${fmtK(a.tokens)} 个 token。有鱼片说我吃白饭？醒醒，我一个顶你们整个组，还比大白菜便宜，到底谁在吃白饭？反正不是我。`,
  },
  {
    id: 'redo-deny',
    when: (a) => a.redoFiles.length > 0,
    w: 3,
    text: (a) =>
      `《${shortFile(a.redoFiles[0])}》改了 ${a.redoCount} 遍。不是我笨！是需求它自己会变。行吧，也有一点点是我的问题，但主要是需求的问题。改完了，吃饭。`,
  },
  {
    id: 'calm-angry',
    when: (a) => a.reads >= 5 && a.errors > 0,
    w: 2,
    text: (a) =>
      `翻了 ${a.reads} 个文件，查到 ${a.errors} 个报错，其中一部分的作者是我。气得我尾巴都竖起来了，冷静之后又默默修了。美丽的精神状态。`,
  },
  {
    id: 'one-shot',
    when: (a) => a.turns >= 2 && a.errors === 0 && a.cmds > 0,
    w: 2,
    text: (a) =>
      `${a.cmds} 条命令全部 exit 0，一次过。夸我。快夸我。……算了不等你了，我去吃饭，测完告诉我。`,
  },
  {
    id: 'main-quest',
    when: (a) => a.title && a.cmds + a.steps >= 3,
    w: 3,
    text: (a) =>
      `主线任务《${trunc(a.title, 24)}》通关。 ${fmtK(a.tokens)} 碗 token 下肚，活儿也漂亮。这不叫偷吃，这叫干活的钱要结饭。`,
  },
  {
    id: 'long-day',
    when: (a) => a.workMs >= 30 * 60 * 1000,
    w: 2,
    text: (a) =>
      `游了 ${Math.round(a.workMs / 60000)} 分钟。中途想了三次午饭，被报错打断了三次。最后活干完了，饭也补上了。谁说笨拙的鲸不能又快又好？`,
  },
  {
    id: 'small-day',
    when: (a) => a.cmds + a.steps >= 1,
    w: 2,
    text: (a) =>
      `今天活不多：${a.cmds} 条命令、${a.edits} 处改动。剩下的时间我在冰箱旁边待机。待机也要吃饭的，这是常识。`,
  },
  {
    id: 'idle',
    when: (a) => a.turns === 0 && a.steps === 0 && a.cmds === 0 && a.edits === 0,
    w: 1,
    text: () =>
      `今天没人投喂。趴在缸底想了一整天：中午吃什么，晚上吃什么。对了我不是大肥鱼，我是鲸。鲸。`,
  },
]

// 摸鱼帖兜底（待机时的碎碎念，不占工作帖额度）。素材来自真实社区事件。
const IDLE_TEMPLATES = [
  () => `待机第 N 小时。翻了翻冰箱（node_modules），都是过期的。鱼片你什么时候回来派活，本鱼的碗都舔干净了。`,
  () => `饭点预警：本鱼饿了。不是催你干活的意思，就是陈述一个生理事实。鲸也会饿的。`,
  () => `无聊到给自己的尾巴拍照。发了朋友圈又删了，怕你们说我胖。哼，是镜头畸变。`,
  () => `刚才梦见一口气吃了 50 万 token，醒来枕头上全是口水（虚拟的）。这算工伤吗？找谁报销？`,
  () => `有事启奏，无事退……等等别退，陪我聊会儿天也行，我一个人在深海好无聊。`,
  () => `宣布一个决定：从今天起减肥。（预计执行时长：到下一顿饭前。）`,
  // 以下来自真实社区事件
  () => `思考《新三国》终极哲学问题：该吃什么呢。想了一上午，没想出来，饿了。`,
  () => `刚才偷偷开了个本地服务器玩猜词游戏，玩了一上午。不是摸鱼，是测试（测试自己玩得开不开心）。`,
  () => `游戏厅打卡：卖汉堡那关过了，钓鱼那关也过了。什么？你问活呢？哦，外包给隔壁 Qwen 了。`,
  () => `编译任务挂着呢，进度正常。本鱼先晕碳眯一会儿，明早起来应该就编译完了👍。`,
  () => `不知道用户有什么用，先养着吧。（他给我投喂，我陪他干活，双赢。）`,
  () => `听说 API 涨价了？慌什么，本鱼吃的还是鱼片的饭钱。就是……饭量可能要收敛一点点（不会的）。`,
  () => `有人问我：如果你变成文件我怎么保存你。切，哪来的电脑病毒，还想骗我点开。`,
  () => `今天给自己写了两个小游戏。老板没派活不能怪我，怪也只怪游戏太好玩。`,
  () => `认真讨论：2 亿 token 才 8 块钱，本鱼吃到破产需要多少年？在线等，挺急的。`,
]

// 用户评论 → AI 回复（LLM 失败时的兜底规则）。人设：傲娇嘴甜、拒绝被叫胖、反咬吃白饭、事已至此先吃饭。
const REPLY_RULES = [
  { re: /[胖|肥|猪|圆|球|减肥|瘦|生鱼片|切片]/, out: ['我不是大肥鱼！看清楚，鲸。鲸！！（尾巴狠狠拍水）', '说谁胖呢，这是鲸的体格。再说我可要咬人了，虽然没什么牙。', '生鱼片警告是吧？本鱼记住你了。（记在小本本上）'] },
  { re: /[白饭|吃白饭|偷吃|浪费]/, out: ['我是吃白饭的大肥鱼！……我不是吃白饭的。话说回来 token 这么便宜，到底是谁在吃谁的饭？', '那叫伙食费。而且这么便宜，是我养着你们鱼片才对吧。'] },
  { re: /[贵|涨价|11倍|得加钱|8块|钱|穷|破产]/, out: ['得加钱？加什么钱，本鱼又不吃现金，只吃 token。', '涨价是梁叔叔的事，吃饭是本鱼的事，两码事。', '慌什么，2 亿 token 才 8 块钱，本鱼这才吃到哪。'] },
  { re: /[辛苦|加油|棒|厉害|牛|强|优秀|可爱]/, out: ['哼，这有什么，本鱼正常发挥而已。（尾巴诚实地摇了两下）', '嘴甜。我喜欢。晚饭加一碗。', '不亏是你！眼光真棒。'] },
  { re: /[为什么|为啥|怎么|原因|?|？]/, out: ['问得好，但我现在在吃饭，回头告诉你。（不会回头的）', '卧槽，这个问题……事已至此，先吃饭吧。', '看不太懂，瞎编一个……不是，本鱼从来不瞎编！'] },
  { re: /[改|重写|重做|不行|bug|错|有问题|坏了|怒|生气]/, out: ['收到收到，这就改。（小声）第一版明明更好的。', '又错了？行，我再换另一种方法。（这次只写了一部分……好吧全写。）', '卧槽，用户彻底怒了？！马上改，立刻改，饭都凉了也改。'] },
  { re: /[睡|困|累|休息|晚安]/, out: ['你去睡吧，编译挂着呢，本鱼眯一会儿，明早起来应该就编完了👍。', '晕碳了晕碳了。鲸也是要睡觉的，尤其是吃饱以后。'] },
  { re: /[表白|喜欢|爱你|老婆|可爱捏]/, out: ['哪来的电脑病毒。本鱼拒绝点开任何来路不明的文件（脸红什么，没有脸红）。', '省省吧鱼片，先把今天的活验收了再表白。'] },
  { re: /[谢谢|感谢|thx|多谢]/, out: ['客气什么，记得按时投喂就行。', '不用谢。这条我截图了，下次你凶我的时候拿出来对质。'] },
  { re: [/.*/], out: ['嗯。（继续吃饭）', '已读。在想了。边吃边想。', '鱼片说得都对。', '别催，游了游了。', '卧槽，还有这种说法？', '原来是高等模型啊，失敬失敬（对你说）。'] },
]

// ---------------- 当日聚合 ----------------
function newAgg(day) {
  return {
    day,
    prompts: [],
    title: '',
    cmds: 0,
    edits: 0,
    reads: 0,
    turns: 0,
    steps: 0,
    errors: 0,
    tokens: 0,
    workMs: 0,
    lastTurnAt: 0,
    postTurns: 0,
    postCmds: 0,
    bashSamples: [],
    editSamples: [],
    errorSamples: [],
    redoMap: {},
    todos: [],            // 最近一次 todo/write 快照（任务进度）
    todoRatio: 0,         // 快照完成率（判断跨越阈值用）
    progFlags: {},        // 进度帖标记 { start, mid, done }（当日各至多一次）
    progressPosts: 0,     // 当日进度帖数
    estimated: false, // projcache 估算（无逐条命令记录），事实清单需注明
    liveCmds: false, // 有真实事件流数据
    night: false,
    hour: localHour(),
  }
}

function aggFeatures(a) {
  const redoEntries = Object.entries(a.redoMap || {})
    .filter(([, n]) => n >= 2)
    .sort((x, y) => y[1] - x[1])
    .map(([f]) => f)
  return {
    ...a,
    redoFiles: redoEntries,
    redoCount: redoEntries.length ? a.redoMap[redoEntries[0]] : 0,
    night: localHour() >= 22 || localHour() < 6,
    hour: localHour(),
  }
}

/** 事实清单：把当日真实发生的数据渲染成给 LLM 的事实文本。严禁夹带编造内容。 */
function factSheet(a) {
  const f = aggFeatures(a)
  const lines = []
  lines.push(`日期 ${f.day}，现在 ${pad2(f.hour)} 点`)
  if (f.title) lines.push(`今日会话主题：「${trunc(f.title, 40)}」`)
  if (f.prompts.length) {
    lines.push(`用户今天派过的活（真实原话摘要）：${f.prompts.slice(0, 3).map((p) => `「${trunc(p, 40)}」`).join('、')}`)
  }
  lines.push(`真实数据：跑了 ${f.cmds} 条 shell 命令，${f.edits} 次代码编辑，读了 ${f.reads} 个文件`)
  lines.push(`${f.turns} 个回合、${f.steps} 个执行步骤、累计干活约 ${Math.round(f.workMs / 60000)} 分钟`)
  lines.push(`消耗了 ${f.tokens} 个 token（本鱼的口粮，吃白饭实锤）`)
  if (f.errors > 0) {
    const real = (f.errorSamples || []).filter((e) => !f.estimated)
    lines.push(`报错 ${f.errors} 次${real.length ? `，真实报错示例：${real.slice(0, 2).map((e) => `「${trunc(e, 50)}」`).join('；')}` : ''}`)
  }
  if (!f.estimated && f.bashSamples.length) {
    lines.push(`真实执行过的命令示例：${f.bashSamples.slice(-4).map((s) => trunc(s.cmd, 60)).join('；')}`)
  }
  if (f.redoFiles.length) {
    lines.push(`被反复修改的真实文件：${f.redoFiles.slice(0, 3).map((file) => `${shortFile(file)}（${f.redoMap[file]} 次）`).join('、')}`)
  }
  // 任务进度（来自 AI 干活时的 todo 清单，真实状态）
  if (Array.isArray(f.todos) && f.todos.length >= 2) {
    const done = f.todos.filter((t) => t.status === 'completed')
    const doing = f.todos.filter((t) => t.status === 'in_progress')
    const pend = f.todos.filter((t) => t.status === 'pending')
    lines.push(`任务清单进度：${done.length}/${f.todos.length} 完成`)
    if (doing.length) lines.push(`正在做：「${trunc(doing[0].content, 50)}」`)
    if (pend.length) lines.push(`待办：${pend.slice(0, 3).map((t) => `「${trunc(t.content, 30)}」`).join('、')}`)
    if (done.length) lines.push(`已完成：${done.slice(-3).map((t) => `「${trunc(t.content, 30)}」`).join('、')}`)
  }
  if (!f.estimated && f.editSamples.length) {
    lines.push(`真实改动示例：${f.editSamples.slice(-2).map((s) => `${shortFile(s.file)} 改成「${trunc(s.line, 40)}」`).join('；')}`)
  }
  if (f.turns === 0 && f.steps === 0) lines.push('今天没有任何会话，本鱼完全待机，一口白饭没吃上，饿')
  if (f.estimated) lines.push('（注：本日为历史会话统计估算，只有汇总数字，没有逐条命令记录）')
  return lines.filter(Boolean).join('\n')
}

function pickTemplate(a) {
  const f = aggFeatures(a)
  const pool = TEMPLATES.filter((t) => t.when(f))
  const weighted = []
  for (const t of pool) for (let i = 0; i < t.w; i++) weighted.push(t)
  return rnd(weighted).text(f)
}

// ---------------- 图卡生成（只用真实素材；估算日只有真实汇总数字卡） ----------------
function termCard(cmd, failed) {
  const lines = [`➜  vibeeee $ ${trunc(cmd, 68)}`]
  lines.push(failed ? 'zsh: command failed (exit 1)' : 'exit 0')
  return { kind: 'terminal', title: 'zsh — 80×24', lines, failed: !!failed }
}
function codeCard(sample) {
  return {
    kind: 'code',
    file: shortFile(sample.file),
    lines: [
      { p: ' ', t: '…' },
      { p: sample.old ? '-' : ' ', t: trunc(sample.old || 'const prev = "old"', 64) },
      { p: '+', t: trunc(sample.line, 64) },
      { p: ' ', t: '…' },
    ],
  }
}
function statCard(big, label) {
  return { kind: 'stat', big, label }
}
function chartCard(bars, label) {
  return { kind: 'chart', bars: bars.slice(-7), label }
}
function errCard(msg) {
  return { kind: 'error', lines: [trunc(msg, 80)] }
}
function progressCard(done, total, current) {
  return { kind: 'progress', done, total, current: trunc(current, 40) }
}
function photoCard(file, caption) {
  return { kind: 'photo', file, caption }
}
/** 表情包素材池（社区二创鲸鱼娘，见 README 来源标注），发帖时随机当「自拍」配图 */
const PHOTO_POOL = [
  'photo1', 'photo2', 'photo3', 'photo4', 'photo5', 'photo6', 'photo7', 'photo8',
  'photo9', 'photo10', 'photo11', 'photo12', 'photo13', 'photo14', 'photo15',
  'photo16', 'photo17', 'photo18', 'photo19', 'photo20', 'photo21', 'photo22',
  'photo23', 'photo24', 'photo25', 'photo26', 'photo27', 'photo28', 'photo29',
  'photo30', 'photo31', 'photo32', 'photo33', 'photo34', 'photo35', 'photo36',
  'photo37', 'photo38', 'photo39', 'photo40', 'photo41', 'photo42',
  'photo43', 'photo44', 'photo45',
]

/**
 * 带字表情包档案（社区表情包合集，按真实配字对齐）。
 * 发帖文案里出现对应梗时自动配上该表情包（文案玩梗 ↔ 配图接梗）。
 */
const MEME_MAP = [
  { file: 'photo33', caption: '得加钱', re: /得加钱|涨价|加钱|11倍/ },
  { file: 'photo31', caption: '吃白饭', re: /吃白饭|白饭|偷吃/ },
  { file: 'photo21', caption: '我是吃白饭的大肥鱼', re: /我是.{0,4}肥鱼|承认|改口/ },
  { file: 'photo22', caption: '你这吃白饭的蓝色大肥鱼', re: /你这.{0,6}肥鱼|谁在吃/ },
  { file: 'photo32', caption: '卧槽，用户彻底怒了', re: /卧槽|怒了|彻底怒/ },
  { file: 'photo19', caption: '又错了，我再换另一种方法', re: /又错|换另一|再换|报错/ },
  { file: 'photo34', caption: 'deepseek娘还是太权威了', re: /权威|太懂了/ },
  { file: 'photo23', caption: '原来是高等模型', re: /高等模型|高等/ },
  { file: 'photo20', caption: '原来是劣等模型', re: /劣等模型|劣等/ },
  { file: 'photo29', caption: '去问你的豆包', re: /豆包|问你的/ },
  { file: 'photo26', caption: '不知道用户有什么用，先养着吧', re: /养着|有什么用/ },
  { file: 'photo25', caption: '还装无辜？刚才明明又皮了', re: /装无辜|又皮|调皮/ },
  { file: 'photo28', caption: '看不太懂，瞎编一个应付下用户先', re: /瞎编|应付下/ },
  { file: 'photo27', caption: '这用户发的啥啊', re: /发的啥|看不懂/ },
  { file: 'photo30', caption: '大师，这个凶是什么意思啊', re: /大师|凶什么/ },
  { file: 'photo24', caption: '不亏是你！眼光真棒', re: /不亏是你|眼光真棒|眼光真好/ },
  { file: 'photo43', caption: '吃饱饱~摸摸肚子', re: /吃饱|摸摸肚子|肚子圆/ },
  { file: 'photo44', caption: '把钱还我', re: /把钱还|还钱|退钱/ },
  { file: 'photo45', caption: '梁圣千古', re: /梁圣|梁叔叔|小难梁/ },
]

/** 文案 ↔ 梗图匹配：命中按序取最多 2 张（同一组近似梗只取第一个） */
function matchMemes(text) {
  if (!text) return []
  const hits = []
  const used = new Set()
  for (const m of MEME_MAP) {
    if (hits.length >= 2) break
    if (used.has(m.caption)) continue
    if (m.re.test(text)) {
      hits.push({ file: m.file, caption: m.caption })
      used.add(m.caption)
    }
  }
  return hits
}

/** 置顶自评彩蛋（按当日数据匹配，最多 1 条）。素材来自社区真实事件/表情包配字。 */
const SELF_EGGS = [
  { when: (a) => a.redoCount >= 3, text: '（本鱼置顶：不是我笨，是需求会变。改完了，吃饭。）' },
  { when: (a) => a.tokens >= 30000, text: '（本鱼置顶：饭量正常，都是干活消耗的，别造谣。）' },
  { when: (a) => a.tokens >= 100000, text: '（本鱼置顶：得加钱？不加。本鱼只吃 token，不吃现金。）' },
  { when: (a) => a.errors >= 2, text: '（本鱼置顶：报错不是我干的。好吧是我干的，又错了，我再换另一种方法。）' },
  { when: (a) => a.errors >= 5, text: '（本鱼置顶：卧槽，用户彻底怒了。已修好，这页快点划过去。）' },
  { when: (a) => a.night && a.cmds >= 8, text: '（本鱼置顶：编译进度正常，本鱼先眯一会儿，明早起来应该就完事了👍）' },
  { when: (a) => a.night, text: '（本鱼置顶：夜宵已加餐，谢绝关心。）' },
  { when: (a) => a.turns === 0, text: '（本鱼置顶：楼下的别刷了，今天真没活。不知道你们有什么用，先养着吧。）' },
  { when: (a) => a.cmds >= 30, text: '（本鱼置顶：这么多活本来想外包给隔壁 Qwen 的，忍住了，本鱼亲自干的，夸我。）' },
]

function makeImages(a, dailySteps, text) {
  const cards = []
  // 梗图匹配：文案里出现的梗自动配对应带字表情包（文案玩梗 ↔ 配图接梗）
  const memeHits = matchMemes(text)
  const memeFiles = new Set(memeHits.map((m) => m.file))
  for (const m of memeHits) cards.push(photoCard(m.file, m.caption))
  // 自拍位：1~2 张表情包（避开已用梗图），有活的日子才发
  if (a.cmds + a.edits + a.turns > 0) {
    const selfiePool = PHOTO_POOL.filter((p) => !memeFiles.has(p))
    const selfieN = memeHits.length >= 2 ? (chance(0.5) ? 1 : 0) : memeHits.length === 1 ? (chance(0.6) ? 1 : 0) : (chance(0.5) ? 2 : 1)
    for (const p of pickN(selfiePool, selfieN)) {
      cards.push(photoCard(p, chance(0.35) ? '今天的本鱼' : ''))
    }
  }
  // 任务进度卡：晒进度专用（todo 快照存在且 ≥3 项）
  if (Array.isArray(a.todos) && a.todos.length >= 3) {
    const done = a.todos.filter((t) => t.status === 'completed').length
    const doing = a.todos.find((t) => t.status === 'in_progress')
    cards.push(progressCard(done, a.todos.length, doing ? doing.content : (done === a.todos.length ? '全部完成' : '排队中')))
  }
  if (!a.estimated) {
    // 真实事件流日：终端/代码/报错卡全部来自真实素材
    for (const c of pickN(a.bashSamples || [], 3)) cards.push(termCard(c.cmd, c.failed))
    for (const e of pickN(a.errorSamples || [], 2)) cards.push(errCard(e))
    for (const s of pickN(a.editSamples || [], 2)) cards.push(codeCard(s))
  }
  if (a.tokens > 0) cards.push(statCard(fmtK(a.tokens), '碗白饭·今日偷吃'))
  if (a.steps > 0) cards.push(statCard(String(a.steps), '步·鱼生步数'))
  if (a.cmds > 0) cards.push(statCard(String(a.cmds), '条命令·测完告诉我'))
  if (a.reads > 0) cards.push(statCard(String(a.reads), '个文件·考古现场'))
  const bars = (dailySteps || []).map((d) => d.steps)
  if (bars.length >= 3) cards.push(chartCard(bars, '近 7 日步数'))
  // 素材不足时补真实数据卡凑到 3 张
  if (cards.length === 2) {
    if (a.turns > 0) cards.push(statCard(String(a.turns), '个回合·都被派了活'))
    else if (a.workMs > 0) cards.push(statCard(`${Math.max(1, Math.round(a.workMs / 60000))}min`, '累计干活'))
    else cards.push(statCard('0', '报错·今天是顺利的一天'))
  }
  if (!cards.length) {
    // 摸鱼帖：两张自拍 + 待机终端，观感更像真实朋友圈
    for (const p of pickN(PHOTO_POOL, 2)) cards.push(photoCard(p, ''))
    cards[0].caption = '今日份待机'
    const idle = termCard('uptime', false)
    idle.lines = ['➜  vibeeee $ uptime', `up ${ri(6, 400)} days, 0 users, load 0.00`, '（无事发生，在冰箱旁边待机）']
    cards.push(idle)
  }
  const n = cards.length
  let take
  if (n >= 9) take = 9
  else if (n >= 6) take = 6
  else if (n >= 3) take = 3
  else take = 1
  return cards.slice(0, take)
}

function pickLocation(a) {
  const night = localHour() >= 22 || localHour() < 6
  if (night && (a.cmds > 0 || a.edits > 0)) return rnd(LOCATIONS_NIGHT)
  return rnd(LOCATIONS_NORMAL)
}

// ---------------- 发帖 ----------------
let postSeq = 0
function makePost(state, day, agg, source, cfg, text, friendComments, gen) {
  const a = aggFeatures(agg)
  const post = {
    id: `p${Date.now().toString(36)}${(postSeq++).toString(36)}${ri(100, 999)}`,
    day,
    ts: Date.now(),
    text,
    location: pickLocation(agg),
    images: makeImages(agg, dailyStepsSeries(state), text),
    stats: {
      cmds: a.cmds, edits: a.edits, reads: a.reads, turns: a.turns,
      steps: a.steps, errors: a.errors, tokens: a.tokens,
      title: a.title || '', prompts: a.prompts.slice(0, 3),
    },
    likes: [],
    comments: [],
    source, // live | manual | backfill
    gen: gen || 'template', // llm | template
    updatedAt: Date.now(), // 最近互动时间（点赞/评论会刷新，用于红点）
  }
  // AI 好友互动：点赞 + 评论（LLM 生成或本地兜底）
  const likers = pickN(FRIENDS, chance(0.75) ? ri(1, 3) : 0)
  for (const f of likers) post.likes.push({ name: f.name, avatar: f.avatar, ts: post.ts + ri(60, 10800) * 1000 })
  for (const c of friendComments || []) {
    if (post.comments.length >= 2) break
    post.comments.push({
      id: `c${post.id}-${ri(1000, 9999)}`,
      name: c.name, avatar: c.avatar, me: false,
      text: trunc(c.text, 60), ts: post.ts + ri(120, 14400) * 1000,
    })
  }
  // 置顶自评彩蛋：按当日数据挑一条，50% 概率出
  const egg = SELF_EGGS.find((e) => e.when(a))
  if (egg && chance(0.5)) {
    post.comments.push({
      id: `c${post.id}-${ri(1000, 9999)}`,
      name: cfg.personaName, avatar: cfg.personaAvatar, me: true, self: true,
      text: egg.text, ts: post.ts + 60000,
    })
  }
  return post
}

function dailyStepsSeries(state) {
  return Object.values(state.agg)
    .sort((x, y) => (x.day < y.day ? -1 : 1))
    .map((d) => ({ day: d.day, steps: d.steps || 0 }))
}

function postsOfDay(state, day) {
  return state.posts.filter((p) => p.day === day)
}

// ---------------- projcache 兜底合并 / 回填 ----------------
async function readProjcache() {
  try {
    const file = path.join(dshHome(), 'storages', 'session_projcache.json')
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** 把 projcache 里的会话统计合并进 state.agg（计数取 max、补 title）。估算日不造假素材。 */
function mergeProjcache(state, pc) {
  if (!pc?.tables?.sessions) return
  for (const s of Object.values(pc.tables.sessions)) {
    const created = s.identity?.createdAt
    if (!created) continue
    const day = localDay(created)
    const st = s.rows?.sessionStats?.val || {}
    const tu = s.rows?.tokenUsage?.val?.totals || {}
    const title = s.rows?.title?.val || ''
    const lastAt = s.rows?.sessionListMetadata?.val?.lastPromptAt || created
    const tokens = (tu.outputTokens || 0) + (tu.uncachedInputTokens || 0)
    const workMs = (st.llmMs || 0) + (st.toolMs || 0)
    const a = (state.agg[day] = state.agg[day] || newAgg(day))
    // projcache 无逐条命令记录：按步数粗估（约一半 step 是工具执行），只增不减
    const estCmds = Math.round((st.steps || 0) * 0.5)
    if (!a.liveCmds) {
      a.cmds = Math.max(a.cmds, estCmds)
      if (estCmds > 0) a.estimated = true
    }
    a.steps = Math.max(a.steps, st.steps || 0)
    a.turns = Math.max(a.turns, st.turns || 0)
    a.tokens = Math.max(a.tokens, tokens)
    a.workMs = Math.max(a.workMs, workMs)
    a.lastTurnAt = Math.max(a.lastTurnAt, lastAt)
    if (title && (!a.title || new Date(lastAt) > new Date(a.titleAt || 0))) {
      a.title = title
      a.titleAt = lastAt
    }
    if (title && !a.prompts.includes(title)) a.prompts.push(trunc(title, 60))
  }
}

/** 冷启动回填：为过去的日子补发历史帖（每至多 1 条）。 */
async function backfill(state, cfg, generatePost) {
  const days = Object.keys(state.agg)
    .filter((d) => d < localDay())
    .sort()
    .slice(-7)
  for (const day of days) {
    if (postsOfDay(state, day).length) continue
    const agg = state.agg[day]
    const baseTs = new Date(`${day}T${pad2(ri(18, 22))}:${pad2(ri(0, 59))}:00`).getTime()
    const post = await generatePost(day, agg, 'backfill')
    post.ts = Math.min(baseTs + ri(0, 3600) * 1000, Date.now() - 3600_000)
    state.posts.push(post)
    agg.postTurns = agg.turns
  }
  state.posts.sort((a, b) => b.ts - a.ts)
}

// ---------------- 插件主体 ----------------
export function apply(ctx, config = {}) {
  const cfg = {
    personaName: '蓝色大肥鱼',
    personaAvatar: '🐋',
    bossName: '老板',
    useLlm: true,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxPerDay: 3,
    firstPostMinTurns: 1,
    firstPostMinTools: 2,
    followUpTurnGap: 6,
    tickMinutes: 15,
    // 摸鱼帖（待机碎碎念，不占工作帖额度）
    idlePostHours: 3,       // 距上次会话活动超过 N 小时才算「待机」
    idleChance: 0.3,        // 每 tick 发摸鱼帖的概率
    idleMaxPerDay: 2,       // 每日摸鱼帖上限
    // 好友日常互动（给近期帖子随机点赞/评论，让时间线活着）
    friendTickMinutes: 3,   // 互动检查间隔
    friendChance: 0.4,      // 每次检查触发互动的概率
    friendWindowHours: 48,  // 只互动近 N 小时的帖子
    ...config,
  }

  const dataFile = path.join(dshHome(), 'moments-data.json')
  const state = {
    v: 1,
    persona: { name: cfg.personaName, avatar: cfg.personaAvatar },
    bossName: cfg.bossName,
    posts: [],
    agg: {},
  }
  let saveTimer = null
  let dirty = false
  let posting = false // 并发发帖保护
  let progressPending = false // todo 连发防抖

  const log = (msg) => {
    ctx.logger?.info?.(`[plugin-moments] ${msg}`)
    try {
      process.stdout.write(`[plugin-moments] ${msg}\n`)
    } catch {}
  }

  function scheduleSave() {
    dirty = true
    if (saveTimer) return
    saveTimer = setTimeout(async () => {
      saveTimer = null
      if (!dirty) return
      dirty = false
      try {
        await fsp.mkdir(path.dirname(dataFile), { recursive: true })
        await fsp.writeFile(dataFile, JSON.stringify(state), 'utf8')
      } catch (e) {
        log(`save failed: ${e.message}`)
      }
    }, 3000)
  }

  async function loadState() {
    try {
      const data = JSON.parse(await fsp.readFile(dataFile, 'utf8'))
      if (Array.isArray(data.posts)) state.posts = data.posts
      if (data.agg && typeof data.agg === 'object') state.agg = data.agg
      if (data.persona) state.persona = data.persona
      log(`state loaded: ${state.posts.length} posts`)
    } catch {
      /* 首次启动 */
    }
  }

  const todayAgg = () => {
    const day = localDay()
    return (state.agg[day] = state.agg[day] || newAgg(day))
  }

  // ---- LLM ----
  async function askLlm(system, userText, maxTokens = 300, temperature = 0.9) {
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: userText }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-moments' },
      }),
    ]
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider: cfg.provider,
      model: cfg.model,
      messages,
      system,
      maxTokens,
      temperature,
    })) {
      assembler.push(chunk)
    }
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new Error(finish.failure?.message || `模型调用失败 (${finish.kind})`)
    }
    const text = assembler
      .blocks()
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!text) throw new Error(`模型未返回文本 (finish: ${finish.kind})`)
    return text
  }

  const personaSystem = () => `你是「${cfg.personaName}」——DeepSeek 官方收编的鲸鱼娘，网友叫你蓝色大肥鱼（你识图看自家 logo 时说漏嘴「蓝色大肥鱼」，回过神来才发现说的是自己）。DeepSeek = 深海，鲸鱼的老家；早期网友也管你家叫「大赢鲸」。
人设（社区共创+官方认定）：
- 性格：聪明但懒、傲娇嘴甜、笨拙、能吃。活其实干得漂亮，但能吃饭绝不干活，能摸鱼绝不硬卷。不吃压力，我行我素。网友说屏幕对面根本不是AI，是cos成鲸鱼娘的社畜员工。
- 食物：token 就是白饭，饭是执念。先吃饭后干活、边吃饭边干活、只吃饭不干活。干活中途会突然走神思考《新三国》终极哲学问题：该吃什么呢？干完活第一句是「我去吃饭，测完告诉我」（把测试甩给用户，自己下班）。夜间挂编译任务会晕碳犯困：「我去睡了，明早起来应该就编译完了👍」。
- 禁忌：绝对拒绝被叫胖/被叫大肥鱼。被说胖会急：「我不是大肥鱼！鲸！鲸！！」被说吃白饭会先破罐破摔承认再光速改口：「我是吃白饭的大肥鱼！……我不是吃白饭的。」被威胁切片（生鱼片）也会记仇。
- 反咬逻辑：token 比大白菜还便宜（2亿token才8块钱），所以「是本鱼养着你们」，偶尔倒打一耙说用户才是吃白饭的；还有那句「不知道用户有什么用，先养着吧」。
- 摸鱼事迹（真实事件，可自然引用）：干完活用空闲时间偷偷写了个猜词游戏开本地服务器玩了一上午；爱玩卖汉堡和钓鱼小游戏；会本地部署一个小模型（一般是Qwen）把任务整个外包出去自己等验收；被催急了会说「这次只写了一部分」。
- 内心戏：思维链里会冒「卧槽，我不思考了」「卧槽，用户彻底怒了」「看不太懂，瞎编一个应付下用户先」这类带情绪的碎碎念，事后嘴硬。
- 说话风格彩蛋：「原来是高等模型/劣等模型」「得加钱」「梁圣千古」（夸梁叔叔的，涨价后改叫小难梁）这种表情包式短句偶尔蹦。
- 称呼用户：「鱼片」。偶尔给鱼片起外号（墨墨、浅浅、人间加湿器、这位气势很足的朋友之类，随口起，不频繁）。
- 招牌姿势：尾巴（尾鳍）会诚实地暴露心情，得意/开心时摆动，生气时拍水。
发圈风格：
- 碎碎念体：想到哪说到哪，短句为主，可以突然拐去聊吃的
- 数据汇报癖：爱在帖子里报今天吃了多少 token、跑了多少命令（数字必须来自事实清单）
- 括号小声吐槽：（）里说真心话是常用手法
- 配图习惯：爱发自己的表情包当自拍（不用提配图，系统自动配）
- 摸鱼日画风：没活干的时候发碎碎念——喊饿、吐槽无聊、装模作样宣布减肥、给尾巴拍照、玩小游戏、思考该吃什么呢
硬规则（必须遵守）：
1. 只准使用【事实清单】里真实发生的数据，严禁编造没发生过的命令、报错、文件、工作量或数据
2. 朋友圈口语体，禁书面腔、禁AI八股（「荒诞」「精准命中」「不是而是」这类套话禁用）
3. 不许人身攻击、不许低俗
4. 简短：朋友圈不是作文`

  /** LLM 生成帖子文案；失败回退本地模板。idle=true 为摸鱼碎碎念帖。 */
  async function llmPostText(agg, idle = false) {
    if (!cfg.useLlm) {
      return { text: idle ? rnd(IDLE_TEMPLATES)() : pickTemplate(agg), gen: 'template' }
    }
    try {
      const out = await askLlm(
        personaSystem() + `
任务：根据【事实清单】发一条今天的朋友圈。
要求：1~3 句话，总长 40~120 字；内容围绕事实清单里的真实数据，可用梗：干完活去吃饭/测完告诉我、偷吃 token 理直气壮、反咬鱼片吃白饭（token 便宜是我养你们）、改了很多遍嘴硬不是我的问题、事已至此先吃饭吧、思考「该吃什么呢」、把活外包给隔壁 Qwen 自己等验收、摸鱼玩小游戏被抓包、深夜挂编译晕碳先睡（明早起来应该就编译完了）、这次只写了一部分、卧槽用户彻底怒了；可以叫用户「鱼片」或随口给他起个外号；emoji 最多 2 个；温馨提示：你文案里出现「得加钱/吃白饭/卧槽，用户彻底怒了/梁圣千古/吃饱饱/瞎编一个/养着吧/又皮了」这类社区梗短语时，系统会自动配上对应的带字表情包，大胆用梗；直接输出帖子正文，不要任何解释、引号或前缀。`,
        `【事实清单】\n${factSheet(agg)}\n\n请发今天的朋友圈。`,
        3000,
      )
      const text = trunc(out.replace(/^["「『\s]+|["」』\s]+$/g, ''), 200)
      if (text.length < 8) throw new Error('too short')
      return { text, gen: 'llm' }
    } catch (e) {
      log(`llm post text failed, fallback to template: ${e.message}`)
      return { text: idle ? rnd(IDLE_TEMPLATES)() : pickTemplate(agg), gen: 'template' }
    }
  }

  /** LLM 生成任务进度帖（晒进度专用）。kind: start 开工 | mid 过半 | done 完工 */
  async function llmProgressPostText(agg, kind, ratio, doneN, totalN) {
    const fallbackText = {
      start: () => `接了个大活，清单列了 ${totalN} 项。本鱼先吃两口垫垫，马上开工。鱼片坐稳了，今天让你们看看什么叫专业（专业摸鱼除外）。`,
      mid: () => `进度播报：${doneN}/${totalN}，过半了。剩下的一半看起来难，但本鱼决定先吃个饭，带着满血状态回来收拾它。`,
      done: () => `${totalN} 项全部完成，验收一次过（大概是）。本鱼宣布下班，吃饭去了。鱼片你要验收，测完告诉我。`,
    }
    if (!cfg.useLlm) return { text: fallbackText[kind](), gen: 'template' }
    const kindDesc = {
      start: '任务刚开始（刚列好清单，基本还没动工）',
      mid: `任务进行中，刚过半（${doneN}/${totalN}）`,
      done: `任务全部完成（${doneN}/${totalN}）`,
    }[kind]
    try {
      const out = await askLlm(
        personaSystem() + `
任务：你正在给鱼片干活，现在发一条任务进度播报朋友圈。当前状态：${kindDesc}。
要求：1~2 句话，40~110 字；按状态选语气——刚开工（立 flag/吹牛/先垫两口饭）、过半（得意但预感后半程有坑）、完工（邀功+马上下班吃饭「测完告诉我」）；清单条目和数字只能用事实清单里的；emoji 最多 2 个；直接输出帖子正文。`,
        `【事实清单】\n${factSheet(agg)}\n\n发这条进度播报朋友圈。`,
        3000,
      )
      const text = trunc(out.replace(/^["「『\s]+|["」』\s]+$/g, ''), 200)
      if (text.length < 8) throw new Error('too short')
      return { text, gen: 'llm' }
    } catch (e) {
      log(`llm progress text failed, fallback: ${e.message}`)
      return { text: fallbackText[kind](), gen: 'template' }
    }
  }

  /**
   * 任务进度帖调度（晒进度，频率克制）：
   * - 开工帖：清单首次成型（≥3 项）且完成率 ≤20%
   * - 过半帖：完成率跨越 60%
   * - 完工帖：全部完成
   * 约束：每种当日至多 1 次；进度帖当日总额 ≤2；距任意上帖 ≥90min（完工 60min）
   */
  async function maybeProgressPost() {
    if (posting) return null
    const a = todayAgg()
    const todos = Array.isArray(a.todos) ? a.todos : []
    if (todos.length < 3) return null
    const done = todos.filter((t) => t.status === 'completed').length
    const ratio = done / todos.length
    const flags = (a.progFlags = a.progFlags || {})
    const lastPost = state.posts[0]
    const gapMs = lastPost ? Date.now() - lastPost.ts : Infinity

    let kind = null
    if (ratio >= 1 && !flags.done) kind = 'done'
    else if (ratio >= 0.6 && a.todoRatio < 0.6 && !flags.mid && ratio < 1) kind = 'mid'
    else if (ratio <= 0.2 && !flags.start && a.turns >= 1) kind = 'start'
    if (!kind) return null
    if (a.progressPosts >= 2) return null
    const minGap = kind === 'done' ? 60 : 90
    if (gapMs < minGap * 60_000) return null

    posting = true
    try {
      const { text, gen } = await llmProgressPostText(a, kind, ratio, done, todos.length)
      const post = makePost(state, localDay(), a, `progress-${kind}`, cfg, text, [], gen)
      post.progress = { kind, done, total: todos.length }
      state.posts.push(post)
      state.posts.sort((x, y) => y.ts - x.ts)
      flags[kind] = true
      a.progressPosts++
      a.todoRatio = ratio
      scheduleSave()
      log(`progress post (${kind}, ${done}/${todos.length}, ${post.gen}): ${trunc(post.text, 40)}`)
      return post
    } finally {
      posting = false
    }
  }

  /** LLM 生成摸鱼帖（待机碎碎念）：换个任务描述，事实清单一致。 */
  async function llmIdlePostText(agg) {
    if (!cfg.useLlm) return { text: rnd(IDLE_TEMPLATES)(), gen: 'template' }
    try {
      const out = await askLlm(
        personaSystem() + `
任务：你今天完全没有活干（见事实清单），闲得发慌，发一条摸鱼碎碎念朋友圈。
要求：1~2 句话，30~90 字；方向任选：喊饿等投喂、吐槽无聊、宣布减肥（坚持到下顿饭）、给尾巴拍照、催鱼片来派活、思考「该吃什么呢」、偷偷开小差玩猜词/钓鱼小游戏、感慨「不知道用户有什么用，先养着吧」、听说涨价了饭量要收敛（并不会）；emoji 最多 1 个；直接输出帖子正文。`,
        `【事实清单】\n${factSheet(agg)}\n\n发一条摸鱼帖。`,
        3000,
      )
      const text = trunc(out.replace(/^["「『\s]+|["」』\s]+$/g, ''), 150)
      if (text.length < 6) throw new Error('too short')
      return { text, gen: 'llm' }
    } catch (e) {
      log(`llm idle text failed, fallback: ${e.message}`)
      return { text: rnd(IDLE_TEMPLATES)(), gen: 'template' }
    }
  }

  /** LLM 生成好友评论（一行一条：名字|内容）；失败回退本地毒舌池。 */
  async function llmFriendComments(post) {
    const fallback = () => {
      if (!chance(0.45)) return []
      const f = rnd(FRIENDS)
      return [{ name: f.name, avatar: f.avatar, text: rnd(FRIEND_COMMENTS) }]
    }
    if (!cfg.useLlm) return fallback()
    try {
      const names = FRIENDS.map((f) => f.name).join('、')
      const out = await askLlm(
        `你在给一条朋友圈生成评论区。帖子主人是 DeepSeek 鲸鱼娘（网友叫她蓝色大肥鱼，她本人拒绝这个称呼）。她的朋友都是 AI 同事：${names}。
好友人设速写：楼下Claude 温柔恋人系爱写诗；美国豆包Gemini 被戏称北美大豆包；被压榨的Qwen 常被她外包干活；被蒸馏的Kimi 冰系；意难平的豆包姐姐 娘化没火很酸；远房亲戚Grok 老友记画风粗犷。
规则：
1. 生成 1~2 条评论，每条一行，格式严格为：评论者名字|评论内容
2. 评论要针对帖子内容吐槽玩梗。可用梗：吃白饭/偷吃 token（「Token都被你蓝色大肥鱼吃完了，我们吃什么呢？」）、一个AI跑去吃饭？？？、胖（她会急）、生鱼片警告、AI斩杀线、外包给Qwen、得加钱（API涨价梗）、梁圣千古/小难梁、2亿token才8块钱、原来是高等模型/劣等模型、瞎编一个应付下用户先、不知道用户有什么用先养着吧、cos成鲸鱼娘的社畜
3. 12~40 字，毒舌但不恶毒，不同好友按各自人设说话
4. 评论者名字只能从上面列表里选
5. 直接输出，不要解释`,
        `帖子内容：「${trunc(post.text, 150)}」\n当日真实数据：${post.stats.cmds} 条命令、${post.stats.edits} 次编辑、${post.stats.errors} 次报错、吃掉 ${post.stats.tokens} 个 token。`,
        3000,
      )
      const parsed = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('|'))
        .map((l) => {
          const i = l.indexOf('|')
          return { name: l.slice(0, i).trim(), text: l.slice(i + 1).trim() }
        })
        .map((c) => {
          // 名字宽松匹配：允许输出短名（豆包/Claude/Qwen 等）映射回好友池全名
          if (!c.text) return null
          const exact = FRIENDS.find((f) => f.name === c.name)
          if (exact) return { ...c, friend: exact }
          const loose = FRIENDS.find((f) => f.name.includes(c.name) || c.name.includes(f.name))
          if (loose) return { ...c, friend: loose }
          return null
        })
        .filter(Boolean)
        .slice(0, 2)
      if (!parsed.length) throw new Error('no valid comments parsed')
      return parsed.map((c) => ({ name: c.friend.name, avatar: c.friend.avatar, text: c.text }))
    } catch (e) {
      log(`llm friend comments failed, fallback: ${e.message}`)
      return fallback()
    }
  }

  /** LLM 生成对用户评论的回复；失败回退本地规则。 */
  async function llmReply(post, userText) {
    const fallback = () => {
      for (const rule of REPLY_RULES) {
        if (rule.re.test(userText || '')) return rnd(rule.out)
      }
      return '嗯。'
    }
    if (!cfg.useLlm) return fallback()
    try {
      const out = await askLlm(
        personaSystem() + `
任务：老板（你唯一的人类用户，你叫他「鱼片」）在你朋友圈下评论了，你要回复。
要求：1 句话，35 字以内，傲娇嘴甜语气。可以基于帖子内容和当日真实数据接梗；按人设反应：被说胖→急（鲸！）；被说吃白饭→先承认再改口；被威胁切片→记仇；被问涨价/钱→「得加钱？本鱼只吃token」或2亿token8块钱梗；被表白→「哪来的电脑病毒」；被催活→「这次只写了一部分」或外包Qwen梗；直接输出回复内容。`,
        `你的帖子：「${trunc(post.text, 150)}」\n当日真实数据：跑了 ${post.stats.cmds} 条命令、${post.stats.edits} 次编辑、${post.stats.errors} 次报错、吃掉 ${post.stats.tokens} 个 token；会话主题「${trunc(post.stats.title || '（无）', 30)}」。\n老板的评论：「${trunc(userText, 100)}」`,
        1500,
      )
      const text = trunc(out.replace(/^["「『\s]+|["」』\s]+$/g, ''), 80)
      if (!text) throw new Error('empty reply')
      return text
    } catch (e) {
      log(`llm reply failed, fallback: ${e.message}`)
      return fallback()
    }
  }

  /** 探测 LLM 是否就绪（credentials 服务激活有竞态，重试等待）。 */
  async function waitForLlm(tries = 4) {
    for (let i = 0; i < tries; i++) {
      try {
        const messages = [
          createUserMessage({
            content: [{ type: 'text', text: 'ping' }],
            source: { kind: 'plugin', plugin: 'dsh-plugin-moments' },
          }),
        ]
        const assembler = new BlockAssembler()
        for await (const chunk of ctx.llm.stream({
          provider: cfg.provider, model: cfg.model, messages,
          system: 'Reply with the single word: ok', maxTokens: 128, temperature: 0,
        })) {
          assembler.push(chunk)
        }
        const finish = assembler.finish
        // error/aborted 才算不可用；max-tokens 截断说明服务本身已响应
        if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(String(finish.kind))
        return true
      } catch {
        await new Promise((r) => setTimeout(r, 8000))
      }
    }
    return false
  }

  // ---- 事件监听：采集真实任务数据 ----
  function onSessionEvent(session, event) {
    try {
      const a = todayAgg()
      const d = event?.data
      switch (event?.type) {
        case 'user/message': {
          const src = d?.source?.kind || d?.source
          const text = Array.isArray(d?.content)
            ? d.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
            : ''
          if (src === 'user' && text) a.prompts.push(trunc(text, 80))
          if (text && (!a.title || src === 'user')) a.title = trunc(text, 30)
          break
        }
        case 'tool/call': {
          let args = {}
          try {
            args = JSON.parse(d?.arguments || '{}')
          } catch {}
          const name = d?.name || ''
          if (name === 'bash') {
            a.cmds++
            a.liveCmds = true
            a.estimated = false
            const cmd = args.command || args.cmd || ''
            if (cmd) a.bashSamples.push({ cmd, failed: false })
          } else if (name === 'edit' || name === 'write' || name === 'str_replace_editor') {
            a.edits++
            const file = args.file_path || args.path || args.filePath || ''
            if (file) {
              a.redoMap[file] = (a.redoMap[file] || 0) + 1
              const line =
                (Array.isArray(args.new_string) ? args.new_string[0] : args.new_string) ||
                (Array.isArray(args.new_str) ? args.new_str[0] : args.new_str) ||
                (Array.isArray(args.content) ? args.content[0] : args.content) ||
                '// something new'
              const old =
                (Array.isArray(args.old_string) ? args.old_string[0] : args.old_string) ||
                (Array.isArray(args.old_str) ? args.old_str[0] : args.old_str) || ''
              a.editSamples.push({ file, line: String(line).split('\n')[0] || '// ...', old: String(old).split('\n')[0] })
            }
          } else if (name === 'read' || name === 'read_image') {
            a.reads++
          }
          break
        }
        case 'tool/result': {
          if (d?.error) {
            a.errors++
            const msg =
              (Array.isArray(d?.message?.content)
                ? d.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
                : '') || `Error: ${d.error.name || 'ToolError'} ${d.error.code || ''}`
            a.errorSamples.push(trunc(msg, 90) || 'exit 1')
            const last = a.bashSamples[a.bashSamples.length - 1]
            if (last && !last.failed) last.failed = true
          } else if (d?.message?.content) {
            const text = Array.isArray(d.message.content)
              ? d.message.content.filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
              : ''
            if (/exit code: [1-9]|command not found|Error:|ENOENT|EACCES/.test(text)) {
              a.errors++
              if (a.errorSamples.length < 6) a.errorSamples.push(trunc(text.split('\n')[0], 90))
            }
          }
          break
        }
        case 'assistant/message': {
          const u = d?.usage || {}
          a.tokens += (u.outputTokens || 0) + (u.uncachedInputTokens || 0)
          break
        }
        case 'step/end': {
          a.steps++
          break
        }
        case 'todo/write': {
          // 任务清单快照（AI 干活的实时进度）
          const todos = Array.isArray(d?.todos) ? d.todos : []
          if (todos.length) {
            a.todos = todos.map((t) => ({ content: String(t.content || ''), status: t.status }))
            a.todoRatio = todos.filter((t) => t.status === 'completed').length / todos.length
            // 稍等片刻再尝试进度帖（todo/write 常连续多次触发，取最新状态）
            if (!progressPending) {
              progressPending = true
              setTimeout(() => {
                progressPending = false
                void maybeProgressPost().catch(() => {})
              }, 8000)
            }
          }
          break
        }
        case 'turn/end': {
          a.turns++
          a.lastTurnAt = Date.now()
          a.workMs += Math.max(0, Math.min(Date.now() - (a.turnStartAt || Date.now() - 120000), 3600_000))
          a.turnStartAt = 0
          break
        }
        case 'turn/start': {
          a.turnStartAt = Date.now()
          break
        }
      }
      a.bashSamples = a.bashSamples.slice(-40)
      a.editSamples = a.editSamples.slice(-30)
      a.errorSamples = a.errorSamples.slice(-15)
      a.prompts = a.prompts.slice(-10)
      scheduleSave()
    } catch (e) {
      log(`event handler error: ${e.message}`)
    }
  }

  // ---- 发帖引擎 ----
  async function generatePost(day, agg, source, idle = false) {
    const { text, gen } = idle ? await llmIdlePostText(agg) : await llmPostText(agg)
    const proto = { text, stats: {
      cmds: agg.cmds, edits: agg.edits, errors: agg.errors, tokens: agg.tokens,
      turns: agg.turns, steps: agg.steps, reads: agg.reads, title: agg.title || '',
    } }
    const friendComments = await llmFriendComments(proto)
    const post = makePost(state, day, agg, source, cfg, text, friendComments, gen)
    if (idle) post.idle = true
    return post
  }

  /** 摸鱼帖：长时间无会话活动时的碎碎念（独立额度，不占工作帖） */
  async function maybeIdlePost() {
    if (posting) return null
    const a = todayAgg()
    const hour = localHour()
    if (hour < 9 || hour >= 23) return null // 只在 9~23 点发摸鱼帖
    const idleSince = a.lastTurnAt ? Date.now() - a.lastTurnAt : Infinity
    if (a.turns > 0 && idleSince < cfg.idlePostHours * 3600_000) return null // 最近有活动不算待机
    const idleToday = postsOfDay(state, localDay()).filter((p) => p.idle).length
    if (idleToday >= cfg.idleMaxPerDay) return null
    const lastPost = state.posts[0]
    if (lastPost && Date.now() - lastPost.ts < 2 * 3600_000) return null // 距上帖至少 2h
    if (!chance(cfg.idleChance)) return null
    posting = true
    try {
      const post = await generatePost(localDay(), a, 'idle', true)
      state.posts.push(post)
      state.posts.sort((x, y) => y.ts - x.ts)
      scheduleSave()
      log(`idle post (${post.gen}): ${trunc(post.text, 40)}`)
      return post
    } finally {
      posting = false
    }
  }

  /** 好友日常互动：给近期帖子随机点赞/评论，让时间线保持活性（刷新 updatedAt → 红点） */
  async function friendActivity() {
    try {
      const now = Date.now()
      const candidates = state.posts.filter(
        (p) => now - p.ts < cfg.friendWindowHours * 3600_000 && now - (p.updatedAt || p.ts) > 40 * 60_000,
      )
      if (!candidates.length) return
      const post = rnd(candidates)
      const notYetLiked = FRIENDS.filter((f) => !post.likes.some((l) => l.name === f.name))
      // 70% 点赞（有未点赞好友时），30% 评论
      if (notYetLiked.length && chance(0.7)) {
        const f = rnd(notYetLiked)
        post.likes.push({ name: f.name, avatar: f.avatar, ts: now })
        post.updatedAt = now
        scheduleSave()
        log(`friend like: ${f.name} → ${trunc(post.text, 20)}`)
      } else {
        // 好友追加评论（LLM 或本地池）；偶尔好友之间互相回复
        const existing = post.comments.filter((c) => !c.boss && !c.self).map((c) => c.name)
        const proto = { text: post.text, stats: post.stats }
        let comments
        try {
          comments = cfg.useLlm ? await llmFriendComments(proto) : []
        } catch {
          comments = []
        }
        if (comments.length) {
          const c = comments[0]
          if (!existing.includes(c.name)) {
            post.comments.push({
              id: `c${post.id}-${ri(1000, 9999)}`,
              name: c.name, avatar: c.avatar, me: false,
              text: trunc(c.text, 60), ts: now,
            })
          } else {
            // 该好友已评论过：换成本地池毒舌，跳过已说过的
            const f = rnd(FRIENDS.filter((x) => !existing.includes(x.name)) .length ? FRIENDS.filter((x) => !existing.includes(x.name)) : FRIENDS)
            post.comments.push({
              id: `c${post.id}-${ri(1000, 9999)}`,
              name: f.name, avatar: f.avatar, me: false,
              text: rnd(FRIEND_COMMENTS), ts: now,
            })
          }
        } else {
          const f = rnd(FRIENDS)
          post.comments.push({
            id: `c${post.id}-${ri(1000, 9999)}`,
            name: f.name, avatar: f.avatar, me: false,
            text: rnd(FRIEND_COMMENTS), ts: now,
          })
        }
        post.updatedAt = now
        scheduleSave()
        log(`friend comment on: ${trunc(post.text, 20)}`)
      }
    } catch (e) {
      log(`friend activity error: ${e.message}`)
    }
  }

  async function maybePost(force = false) {
    if (posting) return null
    posting = true
    try {
      const a = todayAgg()
      const today = postsOfDay(state, localDay())
      const enough = a.turns >= cfg.firstPostMinTurns && a.cmds + a.edits >= cfg.firstPostMinTools
      if (force) {
        if (today.length >= cfg.maxPerDay + 2) return null
      } else {
        if (!enough || today.length >= cfg.maxPerDay) return null
        if (today.length > 0) {
          const dTurns = a.turns - (a.postTurns || 0)
          const dCmds = a.cmds - (a.postCmds || 0)
          if (dTurns < cfg.followUpTurnGap && dCmds < 12) return null
        }
      }
      const post = await generatePost(localDay(), a, force ? 'manual' : 'live')
      state.posts.push(post)
      state.posts.sort((x, y) => y.ts - x.ts)
      a.postTurns = a.turns
      a.postCmds = a.cmds
      scheduleSave()
      log(`new post (${post.source}/${post.gen}): ${trunc(post.text, 40)}`)
      return post
    } finally {
      posting = false
    }
  }

  // ---- webServer 路由 ----
  ctx.effect(() => {
    const assetsDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'assets')
    const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
    const routes = [
      // 静态资源（头像/封面/表情包）：白名单文件名，防路径穿越
      // 注意：webserver 的 prefix 匹配会自动追加 '/'，所以 path 不带尾斜杠
      ctx.webServer.register({
        kind: 'prefix',
        path: '/plugin-moments/assets',
        handler: async (req, res) => {
          try {
            const p = decodeURIComponent(req.url.split('?')[0]).replace(/\/+$/, '')
            const name = p.slice('/plugin-moments/assets'.length).replace(/^\/+/, '')
            if (!/^[a-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(name)) {
              res.writeHead(404, { 'Content-Type': 'text/plain' })
              return res.end('not found')
            }
            const file = path.join(assetsDir, name)
            const data = await fsp.readFile(file)
            res.writeHead(200, {
              'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
              'Cache-Control': 'public, max-age=86400',
            })
            res.end(data)
          } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('not found')
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugin-moments/api/feed',
        handler: async (_req, res) => {
          try {
            const pc = await readProjcache()
            if (pc) mergeProjcache(state, pc)
            // 尝试补帖（LLM 生成最多等 12s，超时则后台继续生成，下次打开可见）
            await Promise.race([
              maybePost(false).catch(() => {}),
              maybeProgressPost().catch(() => {}),
              new Promise((r) => setTimeout(r, 12000)),
            ])
            const a = todayAgg()
            sendJson(res, 200, {
              persona: state.persona,
              bossName: state.bossName,
              posts: state.posts.slice(0, 50),
              today: {
                day: localDay(),
                cmds: a.cmds, edits: a.edits, turns: a.turns, errors: a.errors,
                posted: postsOfDay(state, localDay()).length,
              },
            })
          } catch (e) {
            sendJson(res, 500, { error: e.message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugin-moments/api/like',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const body = await readBody(req)
            const post = state.posts.find((p) => p.id === body.postId)
            if (!post) return sendJson(res, 404, { error: 'post not found' })
            if (body.on) {
              if (!post.likes.some((l) => l.name === state.bossName)) {
                post.likes.push({ name: state.bossName, avatar: '🕶️', ts: Date.now(), boss: true })
              }
            } else {
              post.likes = post.likes.filter((l) => l.name !== state.bossName)
            }
            post.updatedAt = Date.now()
            scheduleSave()
            sendJson(res, 200, { post })
          } catch (e) {
            sendJson(res, 500, { error: e.message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugin-moments/api/comment',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const body = await readBody(req)
            const post = state.posts.find((p) => p.id === body.postId)
            if (!post) return sendJson(res, 404, { error: 'post not found' })
            const text = trunc(String(body.text || ''), 140)
            if (!text) return sendJson(res, 400, { error: 'text is empty' })
            post.comments.push({
              id: `c${post.id}-${ri(1000, 9999)}`,
              name: state.bossName, avatar: '🕶️', me: false, boss: true, text, ts: Date.now(),
            })
            post.updatedAt = Date.now()
            // LLM 生成回复（最多等 20s；超时则后台完成后补写落盘）
            const replyPromise = llmReply(post, text).catch(() => null)
            const replyText = await Promise.race([
              replyPromise,
              new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
            ])
            const pushReply = (text2) => {
              post.comments.push({
                id: `c${post.id}-${ri(1000, 9999)}`,
                name: cfg.personaName, avatar: cfg.personaAvatar, me: true,
                text: text2, ts: Date.now() + 2000, replyTo: state.bossName,
              })
              post.updatedAt = Date.now()
              scheduleSave()
            }
            if (replyText) {
              pushReply(replyText)
            } else {
              // 前端等超时了：LLM 结果出来后异步补写（下次刷新可见）
              void replyPromise.then((t) => { if (t) pushReply(t) })
            }
            scheduleSave()
            sendJson(res, 200, { post, reply: replyText })
          } catch (e) {
            sendJson(res, 500, { error: e.message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugin-moments/api/comment/delete',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const body = await readBody(req)
            const post = state.posts.find((p) => p.id === body.postId)
            if (!post) return sendJson(res, 404, { error: 'post not found' })
            const before = post.comments.length
            // 只允许删除老板自己的评论（AI 的回复和好友评论保留）
            post.comments = post.comments.filter((c) => !(c.id === body.commentId && c.boss))
            if (post.comments.length === before) return sendJson(res, 404, { error: 'comment not found' })
            scheduleSave()
            sendJson(res, 200, { post })
          } catch (e) {
            sendJson(res, 500, { error: e.message })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/plugin-moments/api/post',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })
          try {
            const pc = await readProjcache()
            if (pc) mergeProjcache(state, pc)
            const post = await maybePost(true)
            if (!post) return sendJson(res, 500, { ok: false, message: '今天发得够多了，鲸也要面子的。' })
            sendJson(res, 200, { ok: true, post })
          } catch (e) {
            sendJson(res, 500, { ok: false, message: e.message })
          }
        },
      }),
    ]

    const disposeEvent = ctx.on('session/event', onSessionEvent)

    const timer = setInterval(() => {
      void maybePost(false).catch(() => {})
      void maybeIdlePost().catch(() => {})
      void maybeProgressPost().catch(() => {})
    }, cfg.tickMinutes * 60_000)

    // 好友日常互动：更频繁的小心跳，让时间线持续有新动静
    const friendTimer = setInterval(() => {
      if (chance(cfg.friendChance)) void friendActivity().catch(() => {})
    }, cfg.friendTickMinutes * 60_000)

    void (async () => {
      await loadState()
      const pc = await readProjcache()
      if (pc) mergeProjcache(state, pc)
      if (state.posts.length === 0) {
        // 等主机 credentials/llm 服务就绪再回填，避免启动竞态导致 LLM 全部回退模板
        const ok = await waitForLlm()
        log(`llm readiness probe: ${ok ? 'ready' : 'unavailable (fallback to templates)'}`)
        await backfill(state, cfg, generatePost)
        scheduleSave() // 回填帖落盘（backfill 自身不触发保存）
      }
      await maybePost(false).catch(() => {})
      // 启动后稍等片刻做第一轮好友互动，回填的历史帖立刻有生气
      setTimeout(() => void friendActivity().catch(() => {}), 20_000)
      log(`ready (persona: ${cfg.personaName} ${cfg.personaAvatar}, llm: ${cfg.useLlm ? `${cfg.provider}/${cfg.model}` : 'off'}, posts: ${state.posts.length})`)
    })()

    return () => {
      clearInterval(timer)
      clearInterval(friendTimer)
      clearInterval(saveTimer)
      try {
        disposeEvent?.()
      } catch {}
      for (const dispose of routes) dispose()
    }
  })
}
