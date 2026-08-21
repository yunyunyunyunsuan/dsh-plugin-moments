/**
 * dsh-plugin-moments — 浏览器端。
 * 仿微信朋友圈 UI（手机壳形态）：刷 AI 的时间线、点赞、评论（AI 模板回复）。
 * 挂载 shell.overlay：右下角圆形入口 → 全屏手机框。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-moments',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement

    const API = '/plugin-moments/api'

    // ---------- 全局动画/交互 CSS（一次注入） ----------
    const GLOBAL_CSS = `
@keyframes mFade { from { opacity: 0 } to { opacity: 1 } }
@keyframes mPop { from { opacity: 0; transform: scale(.92) translateY(14px) } to { opacity: 1; transform: none } }
@keyframes mSlideIn { from { opacity: 0; transform: translateX(40px) } to { opacity: 1; transform: none } }
@keyframes mHeartPop { 0% { transform: scale(1) } 35% { transform: scale(1.45) } 65% { transform: scale(.88) } 100% { transform: scale(1) } }
@keyframes mBigHeart { 0% { opacity: 0; transform: scale(.25) } 22% { opacity: 1; transform: scale(1.25) } 55% { opacity: 1; transform: scale(1) } 100% { opacity: 0; transform: scale(1.5) } }
@keyframes mDot { 0%, 18% { opacity: .15 } 50% { opacity: 1 } 82%, 100% { opacity: .15 } }
@keyframes mSpin { to { transform: rotate(360deg) } }
@keyframes mShimmer { from { background-position: -120% 0 } to { background-position: 220% 0 } }
@keyframes mRise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
.mApp { scrollbar-width: none; -ms-overflow-style: none }
.mApp::-webkit-scrollbar { display: none }
.mBtn { transition: opacity .14s ease, transform .14s ease; -webkit-tap-highlight-color: transparent }
.mBtn:hover { opacity: .72 }
.mBtn:active { opacity: .6; transform: scale(.94) }
.mImgCell { cursor: zoom-in; transition: filter .16s ease }
.mImgCell:hover { filter: brightness(.9) }
.mPhotoImg { transition: opacity .3s ease }
.mLikeIcon { display: inline-block; transform-origin: center }
.mLikeIcon.on { animation: mHeartPop .5s ease }
.mDot1 { animation: mDot 1.1s infinite }
.mDot2 { animation: mDot 1.1s infinite .18s }
.mDot3 { animation: mDot 1.1s infinite .36s }
.mSpin { display: inline-block; animation: mSpin .8s linear infinite }
.mSkeleton { background: linear-gradient(100deg, #f2f3f5 40%, #e9eaee 50%, #f2f3f5 60%); background-size: 200% 100%; animation: mShimmer 1.3s infinite }
.mDelCmt { opacity: 0; transition: opacity .15s }
.mCmtRow:hover .mDelCmt { opacity: 1 }
.mCoverImg { transition: transform .5s ease }
.mCoverWrap:hover .mCoverImg { transform: scale(1.04) }
`
    let cssInjected = false
    function GlobalCss() {
      if (!cssInjected) {
        cssInjected = true
        const el = document.createElement('style')
        el.textContent = GLOBAL_CSS
        document.head.appendChild(el)
      }
      return null
    }

    // ---------- 微信色板 ----------
    const C = {
      wxBlue: '#576b95',
      text: '#1a1a1a',
      textSub: '#b2b2b2',
      bgPage: '#ffffff',
      bgGray: '#f7f7f7',
      line: '#efefef',
      red: '#fa5151',
      green: '#07c160',
    }
    const mono = "'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace"

    function timeAgo(ts) {
      const diff = Date.now() - ts
      if (diff < 0) return '刚刚'
      const m = Math.floor(diff / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return `${m}分钟前`
      const h = Math.floor(m / 60)
      if (h < 24) return `${h}小时前`
      if (h < 48) return '昨天'
      if (h < 24 * 7) return `${Math.floor(h / 24)}天前`
      // 超一周：微信显示具体日期
      const d = new Date(ts)
      const now = new Date()
      const md = `${d.getMonth() + 1}月${d.getDate()}日`
      return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
    }

    // ---------- 头像（真实鲸鱼娘，加载失败回退 emoji） ----------
    const AVATAR_URL = '/plugin-moments/assets/avatar.jpg'
    function Avatar({ size = 38, radius = 5, fallback = '🐋', border, fontSize = 22, inline = false }) {
      const [err, setErr] = useState(false)
      const common = {
        width: size, height: size, borderRadius: radius, flex: 'none',
        display: inline ? 'inline-flex' : 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize,
        background: 'linear-gradient(135deg,#4d6bfe 0%,#38bdf8 100%)',
      }
      if (inline) {
        common.verticalAlign = 'middle'
        common.marginRight = 4
      }
      if (border) common.border = border
      return h('div', { style: common },
        err
          ? fallback
          : h('img', {
              src: AVATAR_URL, alt: '蓝色大肥鱼', onError: () => setErr(true),
              style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: radius, display: 'block' },
            }))
    }

    // ---------- 图卡 ----------
    function TerminalCard({ card }) {
      return h('div', {
        style: {
          width: '100%', height: '100%', background: '#15171e', borderRadius: 4,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 3, padding: '4px 6px',
            background: 'rgba(255,255,255,0.06)', flex: 'none',
          },
        },
          ['#ff5f57', '#febc2e', '#28c840'].map((c) =>
            h('span', { key: c, style: { width: 5, height: 5, borderRadius: 5, background: c, display: 'inline-block' } }),
          ),
          h('span', { style: { color: 'rgba(255,255,255,0.35)', fontSize: 6, marginLeft: 4, fontFamily: mono } }, card.title || 'zsh'),
        ),
        h('div', {
          style: { padding: '5px 6px', fontFamily: mono, fontSize: 7.5, lineHeight: 1.6, overflow: 'hidden', flex: 1 },
        },
          (card.lines || []).map((l, i) =>
            h('div', {
              key: i,
              style: {
                color: /failed|error|exit 1|✗/i.test(l) ? '#ff6b6b' : /^➜|^exit 0/.test(l) ? '#4ade80' : '#cdd3e0',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              },
            }, l),
          ),
        ),
      )
    }

    function CodeCard({ card }) {
      const colors = { '+': '#1a7f37', '-': '#cf222e', ' ': '#57606f' }
      return h('div', {
        style: {
          width: '100%', height: '100%', background: '#f6f8fa', borderRadius: 4,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        },
      },
        h('div', {
          style: {
            padding: '3px 7px', background: '#eaeef2', color: '#57606f',
            fontSize: 6.5, fontFamily: mono, flex: 'none', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', borderBottom: '1px solid #d8dee4',
          },
        }, `📄 ${card.file || 'code'}`),
        h('div', { style: { padding: '4px 6px', fontFamily: mono, fontSize: 7, lineHeight: 1.7, overflow: 'hidden', flex: 1 } },
          (card.lines || []).map((l, i) =>
            h('div', {
              key: i,
              style: {
                color: colors[l.p] || colors[' '],
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                background: l.p === '+' ? 'rgba(26,127,55,0.08)' : l.p === '-' ? 'rgba(207,34,46,0.06)' : 'transparent',
                borderRadius: 2,
              },
            }, `${l.p} ${l.t}`),
          ),
        ),
      )
    }

    function StatCard({ card }) {
      return h('div', {
        style: {
          width: '100%', height: '100%', borderRadius: 4,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 3, overflow: 'hidden', padding: 4,
        },
      },
        h('div', { style: { color: '#fff', fontSize: 15, fontWeight: 800, lineHeight: 1 } }, card.big),
        h('div', { style: { color: 'rgba(255,255,255,0.75)', fontSize: 6.5, textAlign: 'center', lineHeight: 1.3 } }, card.label),
      )
    }

    function ErrorCard({ card }) {
      return h('div', {
        style: {
          width: '100%', height: '100%', background: 'linear-gradient(160deg, #2d1114, #1a0508)',
          borderRadius: 4, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '6px 7px',
        },
      },
        h('div', { style: { color: '#ff6b6b', fontSize: 8, fontWeight: 700, marginBottom: 3 } }, '✖ ERROR'),
        h('div', {
          style: { color: '#ffb4b4', fontFamily: mono, fontSize: 7, lineHeight: 1.6, overflow: 'hidden' },
        }, (card.lines || []).join(' ')),
      )
    }

    function ChartCard({ card }) {
      const bars = card.bars || []
      const max = Math.max(...bars, 1)
      return h('div', {
        style: {
          width: '100%', height: '100%', background: '#0f1420', borderRadius: 4,
          display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '6px 7px', gap: 4,
        },
      },
        h('div', { style: { color: 'rgba(255,255,255,0.45)', fontSize: 6, fontFamily: mono } }, '步数趋势 steps'),
        h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 3, flex: 1 } },
          bars.map((v, i) =>
            h('div', {
              key: i,
              style: {
                flex: 1, height: `${Math.max(8, (v / max) * 100)}%`,
                background: i === bars.length - 1 ? '#4ade80' : 'rgba(110,139,255,0.55)',
                borderRadius: 1.5, minWidth: 0,
              },
              title: String(v),
            }),
          ),
        ),
      )
    }

    function PhotoCard({ card }) {
      const [loaded, setLoaded] = useState(false)
      return h('div', {
        style: {
          width: '100%', height: '100%', borderRadius: 4, overflow: 'hidden',
          background: '#e8edf6', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
      },
        !loaded ? h('div', { className: 'mSkeleton', style: { position: 'absolute', inset: 0 } }) : null,
        h('img', {
          src: `/plugin-moments/assets/${card.file}.jpg`, alt: card.caption || '本鱼',
          onLoad: () => setLoaded(true),
          className: 'mPhotoImg',
          style: {
            width: '100%', height: '100%', objectFit: 'cover', display: 'block',
            opacity: loaded ? 1 : 0, position: 'relative',
          },
          onError: (e) => { e.target.style.display = 'none' },
        }),
        card.caption
          ? h('div', {
              style: {
                position: 'absolute', left: 0, right: 0, bottom: 0, padding: '3px 5px',
                background: 'linear-gradient(transparent, rgba(0,0,0,0.45))',
                color: 'rgba(255,255,255,0.92)', fontSize: 8, lineHeight: 1.3,
              },
            }, card.caption)
          : null)
    }

    function ProgressCard({ card }) {
      const pct = card.total ? Math.round((card.done / card.total) * 100) : 0
      const complete = card.done >= card.total
      return h('div', {
        style: {
          width: '100%', height: '100%', borderRadius: 4, overflow: 'hidden',
          background: 'linear-gradient(160deg,#0b2a6b 0%,#1d4ed8 100%)',
          display: 'flex', flexDirection: 'column', padding: '7px 8px', gap: 3, justifyContent: 'center',
        },
      },
        h('div', { style: { color: 'rgba(255,255,255,0.6)', fontSize: 6, letterSpacing: 1 } }, '任务进度'),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 2 } },
          h('span', { style: { color: '#fff', fontSize: 15, fontWeight: 800, lineHeight: 1 } }, `${card.done}`),
          h('span', { style: { color: 'rgba(255,255,255,0.55)', fontSize: 9 } }, `/ ${card.total}`),
          h('span', { style: { color: complete ? '#4ade80' : '#7dd3fc', fontSize: 8, marginLeft: 'auto', fontWeight: 600 } },
            complete ? '✓ 完成' : `${pct}%`),
        ),
        // 进度条
        h('div', { style: { height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' } },
          h('div', {
            style: {
              width: `${pct}%`, height: '100%', borderRadius: 3,
              background: complete ? 'linear-gradient(90deg,#22c55e,#4ade80)' : 'linear-gradient(90deg,#38bdf8,#818cf8)',
              transition: 'width .4s ease',
            },
          })),
        card.current
          ? h('div', {
              style: {
                color: 'rgba(255,255,255,0.85)', fontSize: 7, lineHeight: 1.3, marginTop: 1,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              },
            }, `${complete ? '✔' : '▸'} ${card.current}`)
          : null,
      )
    }

    function ImageCard({ card }) {
      switch (card.kind) {
        case 'terminal': return h(TerminalCard, { card })
        case 'code': return h(CodeCard, { card })
        case 'stat': return h(StatCard, { card })
        case 'error': return h(ErrorCard, { card })
        case 'chart': return h(ChartCard, { card })
        case 'photo': return h(PhotoCard, { card })
        case 'progress': return h(ProgressCard, { card })
        default: return h('div', { style: { width: '100%', height: '100%', background: '#ddd', borderRadius: 4 } })
      }
    }

    // ---------- 图片浏览器（微信式：全屏查看/左右切换/双击点赞/Esc） ----------
    function ImageViewer({ images, index, onIndex, onClose, onDoubleLike, persona }) {
      // 键盘导航
      useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') onClose()
          else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
          else if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [index, images.length, onClose, onIndex])

      const [burst, setBurst] = useState(0) // 双击爱心触发器
      const clickTimer = useRef(null)
      const card = images[index]
      const multi = images.length > 1

      // 单击 260ms 后关闭；双击则取消关闭并点赞（微信手势）
      const onAreaClick = (e) => {
        e.stopPropagation()
        if (clickTimer.current) {
          clearTimeout(clickTimer.current)
          clickTimer.current = null
          setBurst(Date.now())
          onDoubleLike()
        } else {
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null
            onClose()
          }, 260)
        }
      }
      useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current) }, [])

      return h('div', {
        style: {
          position: 'absolute', inset: 0, zIndex: 60, background: '#000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          animation: 'mFade .18s ease',
        },
        // 关闭只走 ✕ / Esc / 单击图区（延迟判定），避免双击点赞误关
      },
        // 主体：photo 直接大图；其他卡用 scale 放大（单击关/双击赞）
        h('div', {
          onClick: onAreaClick,
          style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', cursor: 'zoom-out' },
        },
          card.kind === 'photo'
            ? h('img', {
                src: `/plugin-moments/assets/${card.file}.jpg`,
                style: {
                  maxWidth: '92%', maxHeight: '86%', objectFit: 'contain', borderRadius: 3,
                  animation: 'mSlideIn .18s ease', userSelect: 'none',
                },
                key: card.file,
              })
            : h('div', {
                key: index,
                style: {
                  width: 240 * 1.55, height: 240 * 1.55, flex: 'none',
                  animation: 'mSlideIn .18s ease',
                },
              },
                h('div', {
                  style: {
                    width: 240, height: 240, transform: 'scale(1.55)', transformOrigin: 'top left',
                    borderRadius: 4, overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,.5)',
                  },
                }, h(ImageCard, { card }))),
        ),
        // 双击大爱心
        burst
          ? h('div', {
              key: burst,
              style: {
                position: 'absolute', fontSize: 74, color: '#ff4d6a',
                animation: 'mBigHeart 1s ease forwards', pointerEvents: 'none',
                textShadow: '0 4px 24px rgba(255,77,106,.5)',
              },
            }, '♥')
          : null,
        // 关闭
        h('button', {
          className: 'mBtn',
          onClick: (e) => { e.stopPropagation(); onClose() },
          style: {
            position: 'absolute', top: 10, right: 12, zIndex: 5,
            width: 30, height: 30, borderRadius: 15, border: 'none', cursor: 'pointer',
            background: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 15, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          },
        }, '✕'),
        // 页码
        multi
          ? h('div', {
              style: {
                position: 'absolute', top: 15, left: 0, right: 0, textAlign: 'center',
                color: '#fff', fontSize: 11, fontWeight: 600, pointerEvents: 'none',
              },
            }, `${index + 1} / ${images.length}`)
          : null,
        // 左右箭头
        multi && index > 0
          ? h('button', {
              className: 'mBtn',
              onClick: (e) => { e.stopPropagation(); onIndex(index - 1) },
              style: {
                position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', zIndex: 5,
                width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer',
                background: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 17,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              },
            }, '‹')
          : null,
        multi && index < images.length - 1
          ? h('button', {
              className: 'mBtn',
              onClick: (e) => { e.stopPropagation(); onIndex(index + 1) },
              style: {
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', zIndex: 5,
                width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer',
                background: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 17,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              },
            }, '›')
          : null,
        // photo 角标
        card.caption
          ? h('div', {
              style: {
                position: 'absolute', bottom: 14, left: 0, right: 0, textAlign: 'center',
                color: 'rgba(255,255,255,0.9)', fontSize: 12, pointerEvents: 'none',
              },
            }, card.caption)
          : null,
        // 底部提示
        h('div', {
          style: {
            position: 'absolute', bottom: 34, left: 0, right: 0, textAlign: 'center',
            color: 'rgba(255,255,255,0.35)', fontSize: 10, pointerEvents: 'none',
          },
        }, '双击点赞 · Esc 关闭' + (multi ? ' · ←→ 切换' : '')),
      )
    }

    // 微信九宫格：1 张大图 / 4 张 2x2 / 其余 3 列网格（点击进浏览器）
    function ImageGrid({ images, onOpen }) {
      if (!images || !images.length) return null
      if (images.length === 1) {
        return h('div', {
          className: 'mImgCell',
          onClick: (e) => { e.stopPropagation(); onOpen(0) },
          style: { width: 158, borderRadius: 4, overflow: 'hidden', aspectRatio: '4/3' },
        }, h(ImageCard, { card: images[0] }))
      }
      const cols = images.length === 4 ? 2 : 3
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: 4, maxWidth: 240, marginTop: 8,
        },
      }, images.slice(0, cols === 2 ? 4 : 9).map((img, i) =>
        h('div', {
          key: i, className: 'mImgCell',
          onClick: (e) => { e.stopPropagation(); onOpen(i) },
          style: { aspectRatio: '1/1', borderRadius: 4, overflow: 'hidden' },
        }, h(ImageCard, { card: img }))))
    }

    // ---------- 帖子 ----------
    function PostCard({ post, persona, bossName, onLike, onComment, onDeleteComment, onOpenImage, typingPostId }) {
      const liked = post.likes.some((l) => l.boss)
      const [justLiked, setJustLiked] = useState(false)
      const doLike = (on) => {
        if (on) setJustLiked(true)
        onLike(post, on)
      }
      return h('div', { style: { display: 'flex', gap: 9, padding: '14px 14px 6px', animation: 'mRise .3s ease' } },
        h(Avatar, { size: 38, radius: 5, fallback: persona?.avatar || '🐋' }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { color: C.wxBlue, fontWeight: 600, fontSize: 13.5 } }, persona?.name || '蓝色大肥鱼'),
          h('div', {
            style: {
              color: C.text, fontSize: 13.5, lineHeight: 1.55, marginTop: 3,
              wordBreak: 'break-word', whiteSpace: 'pre-wrap',
            },
          }, post.text),
          post.images && post.images.length ? h(ImageGrid, { images: post.images, onOpen: (i) => onOpenImage(post, i) }) : null,
          post.location
            ? h('div', { style: { color: '#576b95', fontSize: 11.5, marginTop: 7, display: 'flex', alignItems: 'center', gap: 3 } },
                h('span', null, '📍'), h('span', null, post.location))
            : null,
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 },
          },
            h('div', { style: { color: C.textSub, fontSize: 11 } }, timeAgo(post.ts)),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              h('button', {
                className: 'mBtn',
                onClick: () => doLike(!liked),
                style: {
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px',
                  fontSize: 11.5, color: C.wxBlue, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 3,
                },
              },
                h('span', {
                  key: String(liked) + String(justLiked),
                  className: `mLikeIcon ${liked && justLiked ? 'on' : ''}`,
                }, liked ? '❤️' : '🤍'),
                h('span', null, liked ? '取消' : '赞')),
              h('span', { style: { color: '#d9d9d9', fontSize: 11 } }, '·'),
              h('button', {
                className: 'mBtn',
                onClick: () => onComment(post),
                style: {
                  border: 'none', background: 'transparent', cursor: 'pointer', padding: '2px 4px',
                  fontSize: 11.5, color: C.wxBlue, fontFamily: 'inherit',
                },
              }, '评论'),
            ),
          ),
          // 赞区 + 评论区
          post.likes.length || post.comments.length
            ? h('div', {
                style: { background: C.bgGray, borderRadius: 4, marginTop: 8, overflow: 'hidden' },
              },
                post.likes.length
                  ? h('div', { style: { padding: '6px 8px', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
                      h('span', { style: { fontSize: 11.5, color: '#ff4d6a' } }, '♥'),
                      post.likes.map((l, i) =>
                        h('span', { key: i, style: { fontSize: 11.5 } },
                          h('span', { style: { marginRight: 3 } }, l.avatar || ''),
                          h('span', { style: { color: l.boss ? '#4e6bb3' : C.wxBlue, fontWeight: l.boss ? 600 : 400 } }, l.name),
                          i < post.likes.length - 1 ? h('span', { style: { color: C.textSub } }, '，') : null),
                      ),
                    )
                  : null,
                post.comments.map((c) =>
                  h('div', {
                    key: c.id,
                    className: 'mCmtRow',
                    style: {
                      padding: '5px 8px', position: 'relative',
                      borderTop: post.likes.length || c !== post.comments[0] ? `1px solid #f0f0f0` : 'none',
                      fontSize: 11.5, lineHeight: 1.5,
                    },
                  },
                    // 头像：AI 本人的评论用真实照片头像（与帖子头像一致），好友用 emoji
                    c.me
                      ? h(Avatar, { size: 20, radius: 4, inline: true, fallback: persona?.avatar || '🐋' })
                      : h('span', { style: { marginRight: 4 } }, c.avatar || ''),
                    h('span', {
                      style: {
                        color: c.boss ? '#4e6bb3' : C.wxBlue,
                        fontWeight: c.boss || c.self ? 600 : 400, marginRight: 4,
                      },
                    }, c.name),
                    c.replyTo && c.me ? h('span', { style: { color: C.text } }, `回复 ${c.replyTo}：`) : null,
                    h('span', { style: { color: C.text } }, c.text),
                    // 删除自己的评论（hover 显示）
                    c.boss
                      ? h('button', {
                          className: 'mBtn mDelCmt',
                          onClick: () => onDeleteComment(post, c),
                          title: '删除',
                          style: {
                            position: 'absolute', right: 6, top: 4, border: 'none',
                            background: 'transparent', color: C.textSub, cursor: 'pointer',
                            fontSize: 10, padding: 2, fontFamily: 'inherit', lineHeight: 1,
                          },
                        }, '✕')
                      : null,
                  ),
                ),
                typingPostId === post.id
                  ? h('div', {
                      style: {
                        padding: '5px 8px', borderTop: '1px solid #f0f0f0', fontSize: 11.5,
                        color: C.textSub, display: 'flex', alignItems: 'center', gap: 2,
                      },
                    },
                    `${persona?.name || 'TA'} 正在输入`,
                    h('span', { className: 'mDot1' }, '·'),
                    h('span', { className: 'mDot2' }, '·'),
                    h('span', { className: 'mDot3' }, '·'))
                  : null,
              )
            : null,
        ),
      )
    }

    // ---------- 手机壳 ----------
    function StatusBar() {
      const [now, setNow] = useState(new Date())
      useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 15000)
        return () => clearInterval(t)
      }, [])
      const pad = (n) => String(n).padStart(2, '0')
      // 电池：随时间缓慢掉电（纯装饰）
      const hour = now.getHours() + now.getMinutes() / 60
      const pct = Math.max(18, Math.round(92 - hour * 1.8))
      return h('div', {
        style: {
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 20px 4px', color: '#fff', fontSize: 10, fontWeight: 600, flex: 'none',
        },
      },
        h('span', { style: { letterSpacing: 0.5 } }, `${pad(now.getHours())}:${pad(now.getMinutes())}`),
        h('span', { style: { display: 'flex', gap: 5, alignItems: 'center' } },
          // 信号：四根竖条
          h('span', { style: { display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 9 } },
            [4, 6, 8, 10].map((ht, i) =>
              h('span', {
                key: i,
                style: { width: 2.5, height: ht, borderRadius: 1, background: i < 3 ? '#fff' : 'rgba(255,255,255,0.35)' },
              }))),
          // WiFi 弧线（简化为实心扇形符号）
          h('span', { style: { fontSize: 9, lineHeight: 1 } }, '▲'),
          // 电池：外壳 + 电量 + 电池帽
          h('span', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
            h('span', { style: { fontSize: 9, fontWeight: 500, opacity: 0.9 } }, `${pct}`),
            h('span', {
              style: {
                width: 20, height: 10, borderRadius: 3, border: '1px solid rgba(255,255,255,0.55)',
                display: 'flex', alignItems: 'center', padding: 1.5, boxSizing: 'border-box',
              },
            },
              h('span', {
                style: {
                  width: `${pct}%`, height: '100%', borderRadius: 1.5,
                  background: pct > 20 ? '#fff' : '#ff6b6b',
                  transition: 'width .5s',
                },
              })),
            h('span', { style: { width: 1.5, height: 4, borderRadius: 1, background: 'rgba(255,255,255,0.55)' } })),
        ),
      )
    }

    function PhoneShell({ children, onClose, onTitleDblClick }) {
      return h('div', {
        style: {
          width: 'min(400px, 94vw)', height: 'min(780px, 90vh)',
          borderRadius: 36, border: '6px solid #1b1d22', background: '#000',
          boxShadow: '0 32px 90px rgba(0,0,0,0.65), inset 0 0 0 1px rgba(255,255,255,0.08)',
          overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative',
          flex: 'none', animation: 'mPop .26s cubic-bezier(.2,.9,.3,1.2)',
        },
        onClick: (e) => e.stopPropagation(),
      },
        h('div', {
          style: {
            position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
            width: 110, height: 16, background: '#1b1d22', borderRadius: '0 0 14px 14px', zIndex: 30,
          },
        }),
        h('div', { style: { background: 'linear-gradient(180deg,#2b3a55 0%,#3a3f5c 100%)', flex: 'none', zIndex: 20 } },
          h(StatusBar),
          h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px 10px' },
          },
            h('button', {
              className: 'mBtn',
              onClick: onClose,
              title: '关闭',
              style: {
                background: 'transparent', border: 'none', color: '#fff', fontSize: 17, cursor: 'pointer',
                padding: '2px 8px', lineHeight: 1, fontFamily: 'inherit',
              },
            }, '‹'),
            h('span', {
              onDoubleClick: onTitleDblClick,
              title: '双击回到顶部',
              style: { color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'default', userSelect: 'none' },
            }, '朋友圈'),
            // 占位保持标题居中（原相机图标已移除：自己发不了圈）
            h('span', { style: { width: 30, display: 'inline-block' } }, ''),
          ),
        ),
        children,
        // Home Indicator
        h('div', {
          style: {
            position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)',
            width: 110, height: 4, borderRadius: 2, background: 'rgba(0,0,0,0.28)',
            pointerEvents: 'none', zIndex: 55,
          },
        }),
      )
    }

    // ---------- 可拖动悬浮球 ----------
    // 拖动：pointer capture + 5px 阈值区分点击/拖动；位置存 localStorage；视口边界吸附
    function DraggableLauncher({ hasNew, fallback, onOpen }) {
      const [pos, setPos] = useState(null) // 拖动后的 {x,y}（视口坐标）
      const [dragging, setDragging] = useState(false)
      const wrapRef = useRef(null)
      const drag = useRef({ active: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 })

      useEffect(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('moments:launcherPos') || 'null')
          if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            // 恢复时钳制到当前视口内（防窗口变小后球飞出屏幕）
            const x = Math.min(Math.max(8, saved.x), Math.max(8, window.innerWidth - 64))
            const y = Math.min(Math.max(8, saved.y), Math.max(8, window.innerHeight - 64))
            setPos({ x, y })
          }
        } catch {}
      }, [])

      const clamp = (x, y) => ({
        x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 64)),
        y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 64)),
      })

      const onPointerDown = (e) => {
        if (e.button !== 0) return
        const r = wrapRef.current.getBoundingClientRect()
        drag.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top }
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
      }
      const onPointerMove = (e) => {
        const d = drag.current
        if (!d.active) return
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        if (!d.moved && Math.hypot(dx, dy) > 5) { d.moved = true; setDragging(true) }
        if (d.moved) setPos(clamp(d.ox + dx, d.oy + dy))
      }
      const endDrag = (e) => {
        const d = drag.current
        if (!d.active) return
        d.active = false
        setDragging(false)
        if (d.moved) {
          setPos((p) => {
            if (p) { try { localStorage.setItem('moments:launcherPos', JSON.stringify(p)) } catch {} }
            return p
          })
        } else {
          onOpen()
        }
      }

      const anchorStyle = pos
        ? { left: pos.x, top: pos.y }
        : { right: 18, bottom: 96 }

      return h('div', {
        ref: wrapRef,
        onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag,
        style: {
          position: 'fixed', ...anchorStyle, pointerEvents: 'auto',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, zIndex: 10,
          touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
        },
      },
        // 相对定位小容器：红点挂这里，无 overflow 裁剪
        h('div', { style: { position: 'relative' } },
          h('button', {
            title: 'AI 朋友圈（按住可拖动）',
            className: 'mBtn',
            style: {
              width: 52, height: 52, borderRadius: 26, border: '1px solid rgba(255,255,255,0.12)',
              background: 'linear-gradient(135deg,#4d6bfe 0%,#38bdf8 100%)', color: '#fff',
              fontSize: 24, boxShadow: '0 8px 24px rgba(77,107,254,0.45)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0, overflow: 'visible',
            },
          },
            h('img', {
              src: AVATAR_URL, alt: 'AI 朋友圈', draggable: false,
              style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: 26 },
              onError: (e) => {
                e.target.style.display = 'none'
                e.target.parentElement.textContent = fallback
              },
            })),
          hasNew
            ? h('span', {
                style: {
                  position: 'absolute', top: -3, right: -3, width: 13, height: 13, borderRadius: 8,
                  background: '#ff4d6a', border: '2.5px solid #10131a', boxSizing: 'content-box',
                  boxShadow: '0 0 0 1px rgba(255,77,106,0.35), 0 2px 8px rgba(255,77,106,0.5)',
                  animation: 'mDot 2.2s infinite',
                },
              })
            : null),
        dragging
          ? null
          : h('span', {
              style: {
                fontSize: 10, color: 'rgba(235,238,245,0.6)',
                textShadow: '0 1px 3px rgba(0,0,0,0.6)', pointerEvents: 'none', whiteSpace: 'nowrap',
              },
            }, 'AI 朋友圈'),
      )
    }

    // ---------- 主组件 ----------
    function MomentsApp() {
      const [open, setOpen] = useState(false)
      const [feed, setFeed] = useState(null)
      const [commenting, setCommenting] = useState(null) // { postId }
      const [draft, setDraft] = useState('')
      const [typingPostId, setTypingPostId] = useState(null)
      const [busy, setBusy] = useState(false)
      const [viewer, setViewer] = useState(null) // { post, index }
      const [pullDist, setPullDist] = useState(0) // 下拉刷新
      const [refreshing, setRefreshing] = useState(false)
      const [hasNew, setHasNew] = useState(false) // 入口红点
      const scrollRef = useRef(null)
      const pullAcc = useRef(0)
      const touchStartY = useRef(null)

      const loadFeed = useCallback(async () => {
        try {
          const r = await fetch(`${API}/feed`)
          if (r.ok) setFeed(await r.json())
        } catch {}
      }, [])

      // 面板关闭时轮询新帖 → 红点
      useEffect(() => {
        const check = async () => {
          if (open) return
          try {
            const r = await fetch(`${API}/feed`)
            if (!r.ok) return
            const j = await r.json()
            // 最近活动 = 所有帖子的 max(ts, updatedAt)：新帖 / 好友点赞评论都会亮红点
            const latest = (j.posts || []).reduce(
              (m, p) => Math.max(m, p.ts, p.updatedAt || 0), 0)
            const seen = Number(localStorage.getItem('moments:lastSeenTs') || 0)
            setHasNew(latest > seen)
          } catch {}
        }
        void check()
        const t = setInterval(check, 60000)
        return () => clearInterval(t)
      }, [open])

      useEffect(() => {
        if (open) {
          void loadFeed()
          setHasNew(false)
        }
      }, [open, loadFeed])

      // 打开状态下 feed 就绪后记录「已读水位」（含互动更新时间）
      useEffect(() => {
        if (open && feed?.posts?.length) {
          const latest = feed.posts.reduce(
            (m, p) => Math.max(m, p.ts, p.updatedAt || 0), 0)
          localStorage.setItem('moments:lastSeenTs', String(latest))
        }
      }, [open, feed])

      // 面板打开时每 60s 静默刷新：好友的点赞/评论实时浮现（不干扰输入/看图）
      useEffect(() => {
        if (!open) return
        const t = setInterval(() => {
          if (!commenting && !viewer && !busy) void loadFeed()
        }, 60000)
        return () => clearInterval(t)
      }, [open, commenting, viewer, busy, loadFeed])

      // Esc：关 viewer / 收评论
      useEffect(() => {
        if (!open) return
        const onKey = (e) => {
          if (e.key === 'Escape') {
            if (viewer) setViewer(null)
            else if (commenting) { setCommenting(null); setDraft('') }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, viewer, commenting])

      // 下拉刷新：滚顶时滚轮向上（deltaY<0，等价手指下滑）/触摸下拉
      // 用原生监听（React 合成 wheel 在部分场景收不到 CDP 事件），ref 存最新回调
      const doRefreshRef = useRef(null)
      const wheelPullRef = useRef(null)
      const refreshingRef = useRef(false)
      refreshingRef.current = refreshing

      wheelPullRef.current = (e) => {
        const el = scrollRef.current
        if (!el || refreshingRef.current) return
        if (el.scrollTop <= 0 && e.deltaY < 0) {
          // |delta|>60 视为惯性大滚动：到顶瞬间直接忽略，防止误显指示
          if (-e.deltaY > 60) return
          // 单次累积上限 12：刻意的小步滚动才累积（5 步触发刷新）
          pullAcc.current = Math.min(70, pullAcc.current + Math.min(-e.deltaY, 12))
          setPullDist(pullAcc.current)
          if (pullAcc.current >= 60) doRefreshRef.current?.()
        } else if (e.deltaY > 0) {
          pullAcc.current = 0
          setPullDist(0)
        }
      }

      // 内容区挂载后原生监听 wheel（capture 阶段，防冒泡被截）
      useEffect(() => {
        const el = scrollRef.current
        if (!el || !open) return
        const h = (e) => wheelPullRef.current?.(e)
        el.addEventListener('wheel', h, { passive: true, capture: true })
        return () => el.removeEventListener('wheel', h, { capture: true })
      }, [open])

      const onTouchPull = useCallback((e) => {
        const el = scrollRef.current
        if (!el || refreshingRef.current) return
        if (el.scrollTop <= 0) {
          if (e.type === 'touchstart') touchStartY.current = e.touches[0].clientY
          else if (e.type === 'touchmove' && touchStartY.current != null) {
            const d = e.touches[0].clientY - touchStartY.current
            // d>120 视为猛甩惯性，忽略
            if (d > 0 && d <= 120) {
              // 连续 move 事件天然小步累积；限制单步防误触
              pullAcc.current = Math.min(70, pullAcc.current + Math.min(d * 0.6, 12))
              setPullDist(pullAcc.current)
              if (pullAcc.current >= 55) doRefreshRef.current?.()
            }
          }
        }
      }, [])

      const doRefresh = useCallback(async () => {
        if (refreshing) return
        pullAcc.current = 0
        setRefreshing(true)
        setPullDist(0)
        await loadFeed()
        setTimeout(() => setRefreshing(false), 500)
      }, [refreshing, loadFeed])
      doRefreshRef.current = doRefresh

      const onLike = useCallback(async (post, on) => {
        const boss = feed?.bossName || '老板'
        setFeed((f) => f && ({
          ...f,
          posts: f.posts.map((p) => {
            if (p.id !== post.id) return p
            const likes = on
              ? [...p.likes, { name: boss, avatar: '🕶️', boss: true }]
              : p.likes.filter((l) => !l.boss)
            return { ...p, likes }
          }),
        }))
        try {
          const r = await fetch(`${API}/like`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: post.id, on }),
          })
          if (r.ok) {
            const { post: updated } = await r.json()
            setFeed((f) => f && ({ ...f, posts: f.posts.map((p) => (p.id === updated.id ? updated : p)) }))
          }
        } catch {}
      }, [feed?.bossName])

      const onDeleteComment = useCallback(async (post, cmt) => {
        setFeed((f) => f && ({
          ...f,
          posts: f.posts.map((p) => p.id !== post.id ? p : ({ ...p, comments: p.comments.filter((c) => c.id !== cmt.id) })),
        }))
        try {
          await fetch(`${API}/comment/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId: post.id, commentId: cmt.id }),
          })
        } catch {}
      }, [])

      const submitComment = useCallback(async () => {
        if (!commenting || !draft.trim() || busy) return
        const text = draft.trim().slice(0, 140)
        const postId = commenting.postId
        setDraft('')
        setBusy(true)
        setTypingPostId(postId)
        // 乐观显示：提交瞬间上屏（tmp id），API 返回后被服务器版整体替换
        const tmpId = `tmp-${Date.now()}`
        setFeed((f) => f && ({
          ...f,
          posts: f.posts.map((p) => p.id !== postId ? p : ({
            ...p,
            comments: [...p.comments, { id: tmpId, name: feed?.bossName || '老板', avatar: '🕶️', boss: true, me: false, text }],
          })),
        }))
        try {
          const r = await fetch(`${API}/comment`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId, text }),
          })
          if (r.ok) {
            const { post: updated, reply } = await r.json()
            setTimeout(() => {
              setTypingPostId(null)
              void loadFeed()
            }, 1600)
            // 用服务器返回的帖子整体替换：正式 id 评论落位（含 AI 回复），tmp 乐观行被替换掉
            if (updated) {
              setFeed((f) => f && ({ ...f, posts: f.posts.map((p) => (p.id === updated.id ? updated : p)) }))
            } else {
              // 服务器未返回帖子时保留乐观行
              setFeed((f) => f && ({
                ...f,
                posts: f.posts.map((p) => p.id !== postId ? p : ({
                  ...p,
                  comments: [...p.comments, { id: `tmp-${Date.now()}`, name: feed?.bossName || '老板', avatar: '🕶️', boss: true, me: false, text }],
                })),
              }))
            }
            void reply
          } else {
            setTypingPostId(null)
          }
        } catch {
          setTypingPostId(null)
        } finally {
          setBusy(false)
        }
      }, [commenting, draft, busy, loadFeed, feed?.bossName])

      const nudge = useCallback(async () => {
        setBusy(true)
        try {
          await fetch(`${API}/post`, { method: 'POST' })
          await loadFeed()
        } catch {} finally { setBusy(false) }
      }, [loadFeed])

      const closePanel = () => { setOpen(false); setCommenting(null); setViewer(null) }

      // ---------- 入口按钮：可拖动悬浮球（带新帖红点） ----------
      const launcher = h(DraggableLauncher, {
        hasNew,
        fallback: feed?.persona?.avatar || '🐋',
        onOpen: () => setOpen(true),
      })

      return h(React.Fragment, null,
        h(GlobalCss),
        launcher,
        open
          ? h('div', {
              onClick: closePanel,
              style: {
                position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(8,9,13,0.72)',
                backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
                pointerEvents: 'auto', boxSizing: 'border-box', animation: 'mFade .2s ease',
              },
            },
              h(PhoneShell, {
                onClose: closePanel,
                onTitleDblClick: () => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }),
              },
                // 内容滚动区
                h('div', {
                  ref: scrollRef,
                  className: 'mApp',
                  onTouchStart: onTouchPull,
                  onTouchMove: onTouchPull,
                  onClick: (e) => {
                    // 点击空白收起评论框（点图片/按钮已 stopPropagation）
                    if (commenting && !e.target.closest('.mCommentBar')) {
                      setCommenting(null)
                      setDraft('')
                    }
                  },
                  style: {
                    flex: 1, overflowY: 'auto', background: C.bgPage, position: 'relative',
                    overscrollBehavior: 'contain', paddingBottom: commenting ? 96 : 24,
                    transition: 'padding-bottom .2s ease',
                  },
                },
                  // 下拉刷新指示
                  pullDist > 0 || refreshing
                    ? h('div', {
                        style: {
                          position: 'absolute', top: refreshing ? 8 : Math.max(0, pullDist - 26), left: 0, right: 0,
                          display: 'flex', justifyContent: 'center', zIndex: 10,
                          transition: 'top .15s', pointerEvents: 'none',
                        },
                      },
                        refreshing
                          ? h('span', { className: 'mSpin', style: { fontSize: 15, color: '#999' } }, '◌')
                          : h('span', { style: { fontSize: 10, color: pullDist >= 55 ? '#07c160' : '#bbb', fontWeight: 500 } },
                              pullDist >= 55 ? '松开刷新' : '下拉刷新'))
                    : null,
                  // 封面：鲸鱼娘大图 + 深蓝渐变压暗保证文字可读
                  h('div', {
                    className: 'mCoverWrap',
                    style: {
                      height: 132, position: 'relative', flex: 'none', overflow: 'hidden',
                    },
                  },
                    h('div', {
                      className: 'mCoverImg',
                      style: {
                        position: 'absolute', inset: 0,
                        backgroundImage: 'url(/plugin-moments/assets/cover.jpg)',
                        backgroundSize: 'cover', backgroundPosition: 'center 28%',
                      },
                    }),
                    h('div', {
                      style: {
                        position: 'absolute', inset: 0,
                        background: 'linear-gradient(180deg, rgba(7,20,55,0.42) 0%, rgba(7,20,55,0.12) 45%, rgba(7,20,55,0.62) 100%)',
                      },
                    }),
                    h('div', {
                      style: {
                        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.95)',
                      },
                    },
                      h('div', { style: { fontSize: 26 } }, feed?.persona?.avatar || '🐋'),
                      h('div', { style: { fontSize: 11, marginTop: 4, letterSpacing: 2, opacity: 0.85 } },
                        '先 吃 饭 后 干 活'),
                    ),
                    h('div', {
                      style: {
                        position: 'absolute', right: 12, bottom: -18, display: 'flex',
                        alignItems: 'center', gap: 7,
                      },
                    },
                      h('span', { style: { color: '#fff', fontSize: 11.5, fontWeight: 500, textShadow: '0 1px 3px rgba(0,0,0,0.5)' } }, feed?.persona?.name || '蓝色大肥鱼'),
                      h(Avatar, { size: 36, radius: 5, border: '2px solid #fff' }),
                    ),
                  ),
                  h('div', { style: { height: 26 } }),
                  // 今日催更卡
                  today().posted === 0
                    ? h('div', {
                        style: { margin: '0 14px 6px', background: '#fffbe8', border: '1px solid #ffe9a8', borderRadius: 8, padding: '9px 11px', display: 'flex', alignItems: 'center', gap: 8 },
                      },
                        h('img', {
                          src: '/plugin-moments/assets/photo5.jpg', alt: '在吃饭',
                          style: { width: 30, height: 30, borderRadius: 5, objectFit: 'cover', flex: 'none' },
                          onError: (e) => { e.target.replaceWith(Object.assign(document.createElement('span'), { textContent: '💤' })) },
                        }),
                        h('div', { style: { flex: 1, fontSize: 11.5, color: '#8a6d1a', lineHeight: 1.45 } },
                          'TA 今天还没发朋友圈', h('br'),
                          h('span', { style: { color: '#b2b2b2', fontSize: 10.5 } },
                            `大概率在吃白饭 · 今日已偷吃 ${today().cmds} 条命令的量`)),
                        h('button', {
                          onClick: nudge, disabled: busy, className: 'mBtn',
                          style: {
                            border: 'none', background: busy ? '#9de3bd' : '#07c160', color: '#fff', fontSize: 11,
                            borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
                          },
                        }, busy ? '催促中…' : '催一条'),
                      )
                    : null,
                  // 帖子流 / 骨架屏
                  feed && posts().length
                    ? posts().map((p) => h(PostCard, {
                        key: p.id, post: p, persona: feed?.persona, bossName: feed?.bossName,
                        onLike, onComment: (post) => { setCommenting({ postId: post.id }); setViewer(null) },
                        onDeleteComment, onOpenImage: (post, i) => setViewer({ post, index: i }),
                        typingPostId,
                      }))
                    : !feed
                      ? h(FeedSkeleton)
                      : h('div', { style: { padding: '60px 20px', textAlign: 'center', color: C.textSub, fontSize: 12, lineHeight: 2 } },
                          'TA 还没有朋友圈', h('br'), '（在吃饭，测完告诉我）'),
                  h('div', { style: { textAlign: 'center', color: '#d9d9d9', fontSize: 10.5, padding: '18px 0 30px' } }, '没有更多了'),
                ),
                // 评论输入条（手机内底部）
                commenting
                  ? h('div', {
                      className: 'mCommentBar',
                      style: {
                        position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 40,
                        background: 'rgba(250,250,250,0.97)', borderTop: '1px solid #e5e5e5',
                        padding: '8px 10px 14px', display: 'flex', gap: 8, alignItems: 'center',
                        boxShadow: '0 -4px 16px rgba(0,0,0,0.06)', animation: 'mRise .2s ease',
                      },
                    },
                      h('input', {
                        autoFocus: true,
                        value: draft,
                        onChange: (e) => setDraft(e.target.value.slice(0, 140)),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void submitComment() }
                          if (e.key === 'Escape') { setCommenting(null); setDraft('') }
                        },
                        placeholder: '评论…（TA 会回你的）',
                        maxLength: 140,
                        style: {
                          flex: 1, border: 'none', background: '#f2f2f2', borderRadius: 6,
                          padding: '8px 10px', fontSize: 12.5, outline: 'none', fontFamily: 'inherit', color: C.text,
                        },
                      }),
                      draft.length > 100
                        ? h('span', { style: { fontSize: 9.5, color: '#bbb', flex: 'none' } }, `${140 - draft.length}`)
                        : null,
                      h('button', {
                        className: 'mBtn',
                        onClick: () => { setCommenting(null); setDraft('') },
                        style: { border: 'none', background: 'transparent', color: C.textSub, fontSize: 12, cursor: 'pointer', padding: 6, fontFamily: 'inherit' },
                      }, '收起'),
                      h('button', {
                        className: 'mBtn',
                        onClick: () => void submitComment(),
                        disabled: busy || !draft.trim(),
                        style: {
                          border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12, cursor: 'pointer',
                          fontFamily: 'inherit', fontWeight: 500,
                          background: draft.trim() && !busy ? '#07c160' : '#c8e6cd', color: '#fff',
                        },
                      }, busy ? '发送中' : '发送'),
                    )
                  : null,
                // 图片浏览器（手机内全屏）
                viewer
                  ? h(ImageViewer, {
                      images: viewer.post.images,
                      index: viewer.index,
                      onIndex: (i) => setViewer({ ...viewer, index: i }),
                      onClose: () => setViewer(null),
                      onDoubleLike: () => {
                        const post = viewer.post
                        if (!post.likes.some((l) => l.boss)) onLike(post, true)
                      },
                      persona: feed?.persona,
                    })
                  : null,
              ),
            )
          : null,
      )

      function posts() { return feed?.posts || [] }
      function today() { return feed?.today || { posted: 1 } }
    }

    // 加载骨架屏
    function FeedSkeleton() {
      return h('div', null,
        [0, 1].map((k) =>
          h('div', { key: k, style: { display: 'flex', gap: 9, padding: '14px 14px 6px' } },
            h('div', { className: 'mSkeleton', style: { width: 38, height: 38, borderRadius: 5, flex: 'none' } }),
            h('div', { style: { flex: 1 } },
              h('div', { className: 'mSkeleton', style: { width: 84, height: 13, borderRadius: 3, marginBottom: 8 } }),
              h('div', { className: 'mSkeleton', style: { width: '92%', height: 12, borderRadius: 3, marginBottom: 5 } }),
              h('div', { className: 'mSkeleton', style: { width: '68%', height: 12, borderRadius: 3, marginBottom: 9 } }),
              h('div', { className: 'mSkeleton', style: { width: 160, height: 100, borderRadius: 4 } })))))
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'plugin-moments', order: 95 }, MomentsApp),
      )
    }

    return { apply, inject }
  },
})
