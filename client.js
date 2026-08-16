// 角色表情立绘插件 —— Client 半（dsh client bundle，手写）
// 功能：
//   1. 对话右侧固定浮层显示当前角色/情绪立绘（shell.overlay 全屏穿透层），
//      每 2 秒 fetch /character-emote/state 轮询，模型调用 set_expression 后自动切图；
//      支持复合情绪（主+副）标签与心情基线（mood）指示
//   2. 立绘可直接交互：按住拖动换位置（拖完记忆）、滚轮缩放大小，无需去设置页
//   3. 样式配置（大小/位置/透明度/动画）持久化走 Host（$DSH_HOME JSON，跨重启/端口恢复）
//      + 'char-emote-style' 自定义事件同步（浮层与设置页双向跟随）
//   4. 设置 → 角色立绘 小节：角色切换、刷新、样式调节
//   5. 情绪模式（v0.6.0 P0-1）：auto/manual/paused，设置页切换；manual 下应用「待定情绪」或点选手动应用
//   6. 无更高档位立绘时用 scale 模拟强度（P0-2 visualIntensity）；角色切换预加载全部立绘（P0-3）
//   7. 轮询 effect 单次建立 + ref 比较（P0-4 重构，过渡动画不被轮询重置）
// 样式全内联 + dsw alias 变量；浮层立绘本体 pointer-events 开启以支持拖动。
window.__ModuleLoader__.load({
  id: 'dsh-character-emote-plugin',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');

    var POLL_MS = 2000;
    var STYLE_EVENT = 'char-emote-style';
    var MIN_SIZE = 120;
    var MAX_SIZE = 420;
    var SAVE_THROTTLE_MS = 250;

    // ── 样式配置（模块级 ref 保证拖动/滚轮的连续状态同步）──
    // 持久化走 Host（$DSH_HOME/dsh-character-emote-style.json）：宿主重启端口会变，
    // localStorage 按端口隔离会丢，Host 文件才能跨重启/端口恢复。
    function defaultStyle() {
      var w = window.innerWidth || 1200;
      var h = window.innerHeight || 800;
      return {
        size: 260,
        side: 'right',
        x: w - 28 - Math.round(260 * 0.7),
        y: h - 260 - 140,
        opacity: 100,
        animate: true,
      };
    }

    var styleRef = { current: defaultStyle() };

    // 启动时从 Host 拉样式（跨重启/端口恢复）；失败保持默认
    function fetchHostStyle() {
      fetch('/character-emote/style', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (s && typeof s === 'object') {
            styleRef.current = s;
            try { window.dispatchEvent(new CustomEvent(STYLE_EVENT, { detail: s })); } catch (e) {}
          }
        })
        .catch(function () { /* 保持默认 */ });
    }

    // 应用样式（更新 ref + 组件状态 + 广播给另一侧），不落盘
    function applyStyle(patch) {
      var next = Object.assign({}, styleRef.current, patch);
      styleRef.current = next;
      try { window.dispatchEvent(new CustomEvent(STYLE_EVENT, { detail: next })); } catch (e) {}
      return next;
    }
    // 持久化（拖动结束 / 滚轮节流 / 设置页操作时调用）→ POST Host
    function persistStyle() {
      try {
        fetch('/character-emote/style', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(styleRef.current),
        }).catch(function () {});
      } catch (e) {}
    }

    // 心情数值 → 文案（client 侧展示层转换，数据来自 Host）
    function moodText(v) {
      if (v >= 0.6) return '😊 开心';
      if (v >= 0.2) return '🙂 不错';
      if (v > -0.2) return '😐 平静';
      if (v > -0.6) return '🙁 低落';
      return '😢 难过';
    }
    function arousalText(a) {
      if (a >= 0.6) return '激动';
      if (a >= 0.3) return '平稳';
      return '平静';
    }

    // ── 右侧立绘浮层 ──
    function EmoteStand() {
      var state = react.useState(null);
      var cur = state[0];
      var setCur = state[1];
      var styleState = react.useState(styleRef.current);
      var style = styleState[0];
      var setStyle = styleState[1];

      // 立绘切换动画状态
      var transitionState = react.useState(false);
      var isTransitioning = transitionState[0];
      var setIsTransitioning = transitionState[1];

      // P0-4（v0.6.0）：ref 记录当前 file / 过渡中标志 / 已预加载角色，
      // 轮询 effect 只建一次，过渡计时器不会被轮询重置
      var fileRef = react.useRef(null);
      var transRef = react.useRef(false);
      var preloadedRef = react.useRef(null);

      // 样式同步：监听广播事件（设置页改动 / 本组件拖动）
      react.useEffect(function () {
        function onStyle(e) { if (e && e.detail) setStyle(e.detail); }
        window.addEventListener(STYLE_EVENT, onStyle);
        return function () { window.removeEventListener(STYLE_EVENT, onStyle); };
      }, []);

      // P0-3（v0.6.0）：角色变化时预加载该角色全部立绘（new Image 预热，弱网不闪）
      function preloadCharacter(d) {
        var cid = d && d.character;
        if (!cid || preloadedRef.current === cid) return;
        preloadedRef.current = cid;
        var files = (d && Array.isArray(d.files)) ? d.files : [];
        for (var i = 0; i < files.length; i++) {
          var img = new Image();
          img.src = '/character-emote/file/' + encodeURIComponent(files[i]);
        }
      }

      // 情绪状态轮询（单次 effect + ref 比较；过渡期间跳过，避免计时器被重置）
      react.useEffect(function () {
        function load() {
          fetch('/character-emote/state', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || typeof d.file !== 'string' || !d.file) return;
              preloadCharacter(d);
              var prev = fileRef.current;
              if (transRef.current) return;
              if (prev && d.file !== prev) {
                transRef.current = true;
                fileRef.current = d.file;
                setIsTransitioning(true);
                setTimeout(function () {
                  transRef.current = false;
                  setCur(d);
                  setIsTransitioning(false);
                }, 300); // 300ms 过渡时间
              } else {
                fileRef.current = d.file;
                setCur(d);
              }
            })
            .catch(function () { /* 轮询失败静默，下轮再试 */ });
        }
        load();
        var id = setInterval(load, POLL_MS);
        return function () { clearInterval(id); };
      }, []);

      if (!cur || !cur.file) return null;

      // 位置：left/right 贴边对齐；free = 拖动后的自由坐标
      var posStyle;
      if (style.side === 'left') posStyle = { left: 28, top: style.y };
      else if (style.side === 'right') posStyle = { right: 28, top: style.y };
      else posStyle = { left: style.x, top: style.y };

      var emoText = cur.emotion || '';
      if (cur.secondary) emoText += ' + ' + cur.secondary;
      var mood = (cur && cur.mood) || { valence: 0, arousal: 0 };
      // P0-2（v0.6.0）：无更高档位图时 host 返回 visualIntensity(0..1)，用 scale 模拟视觉强度
      var vis = (cur && typeof cur.visualIntensity === 'number') ? cur.visualIntensity : 0;
      var visScale = (1 + vis * 0.16).toFixed(3);

      // 情绪强度可视化
      function renderIntensityBar(intensity, maxIntensity) {
        maxIntensity = maxIntensity || 3;
        var bars = [];
        for (var i = 0; i < maxIntensity; i++) {
          bars.push(react.createElement('div', {
            key: i,
            style: {
              width: 12,
              height: 4,
              borderRadius: 2,
              background: i < intensity ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)',
              marginRight: 2
            }
          }));
        }
        return react.createElement('div', {
          style: { display: 'flex', marginTop: 4 }
        }, bars);
      }

      // 拖动换位置：mousedown 记录起点与当前 DOM 位置 → free 坐标
      function onDragStart(e) {
        if (e.button !== 0) return;
        e.preventDefault();
        var rect = e.currentTarget.getBoundingClientRect();
        var baseX = rect.left, baseY = rect.top;
        var sx = e.clientX, sy = e.clientY;
        var moved = false;
        function onMove(ev) {
          moved = true;
          applyStyle({ side: 'free', x: Math.round(baseX + (ev.clientX - sx)), y: Math.round(baseY + (ev.clientY - sy)) });
        }
        function onUp() {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
          if (moved) persistStyle();
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }

      // 滚轮缩放：向上放大，向下缩小（节流写盘）
      var lastWheelSave = 0;
      function onWheel(e) {
        e.preventDefault();
        var delta = e.deltaY < 0 ? 10 : -10;
        applyStyle({ size: Math.max(MIN_SIZE, Math.min(MAX_SIZE, style.size + delta)) });
        var now = Date.now();
        if (now - lastWheelSave > SAVE_THROTTLE_MS) {
          lastWheelSave = now;
          persistStyle();
        }
      }

      return react.createElement(
        'div',
        Object.assign({
          style: Object.assign({
            position: 'fixed',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            userSelect: 'none',
            pointerEvents: 'none',
            opacity: style.opacity / 100,
            transition: style.animate ? 'opacity .25s ease' : 'none',
          }, posStyle),
          title: '按住图片拖动位置，滚轮调大小',
        }),
        react.createElement('img', {
          src: '/character-emote/file/' + encodeURIComponent(cur.file),
          alt: emoText,
          style: {
            height: style.size,
            width: 'auto',
            borderRadius: 12,
            boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
            transition: style.animate ? 'height .2s ease, opacity .25s ease, transform .3s ease' : 'none',
            pointerEvents: 'auto',
            cursor: 'move',
            transform: isTransitioning ? 'scale(0.95)' : 'scale(' + visScale + ')',
            opacity: isTransitioning ? 0.7 : 1
          },
          onMouseDown: onDragStart,
          onWheel: onWheel,
          onError: function () { setCur(null); }
        }),
        emoText
          ? react.createElement(
              'span',
              {
                style: {
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-tertiary, #ddd)',
                  background: 'rgba(0,0,0,0.45)',
                  padding: '2px 10px',
                  borderRadius: 10,
                  whiteSpace: 'nowrap',
                }
              },
              (cur.character ? cur.character + ' · ' : '') + emoText
            )
          : null,
        // 情绪强度指示器
        cur.intensity > 0 ? renderIntensityBar(cur.intensity) : null
      );
    }

    // ── 设置页：角色立绘 ──
    function EmoteSettings(props) {
      var ctx = props.ctx;

      var charsState = react.useState([]);
      var chars = charsState[0];
      var setChars = charsState[1];
      var curState = react.useState(null);
      var cur = curState[0];
      var setCur = curState[1];
      var err = react.useState('');
      var error = err[0];
      var setError = err[1];
      var styleState = react.useState(styleRef.current);
      var style = styleState[0];
      var setStyle = styleState[1];

      react.useEffect(function () {
        function onStyle(e) { if (e && e.detail) setStyle(e.detail); }
        window.addEventListener(STYLE_EVENT, onStyle);
        return function () { window.removeEventListener(STYLE_EVENT, onStyle); };
      }, []);

      function loadChars() {
        fetch('/character-emote/characters', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : []; })
          .then(function (arr) {
            if (Array.isArray(arr)) setChars(arr);
          })
          .catch(function () { setChars([]); });
      }
      function loadState() {
        fetch('/character-emote/state', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) { if (d && typeof d === 'object') setCur(d); })
          .catch(function () {});
      }

      react.useEffect(function () {
        loadChars();
        loadState();
        var id = setInterval(loadState, POLL_MS);
        return function () { clearInterval(id); };
      }, []);

      function pick(id) {
        setError('');
        fetch('/character-emote/character', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) { setCur(d.state); loadChars(); }
            else { setError((d && d.error) || '切换失败'); }
          })
          .catch(function () { setError('切换失败（Host 路由不可达）'); });
      }

      // 刷新：重新扫描 characters/（丢图/加角色后不用重启 WebUI）
      function refresh() {
        setError('');
        fetch('/character-emote/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) { setCur(d.state); loadChars(); }
            else { setError((d && d.error) || '刷新失败'); }
          })
          .catch(function () { setError('刷新失败（Host 路由不可达）'); });
      }

      // ── 情绪模式（v0.6.0 P0-1）：auto/manual/paused ──
      function setMode(nextMode) {
        setError('');
        fetch('/character-emote/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: nextMode })
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) { loadState(); }
            else { setError((d && d.error) || '切换模式失败'); }
          })
          .catch(function () { setError('切换模式失败（Host 路由不可达）'); });
      }
      function postApply(body) {
        fetch('/character-emote/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) { loadState(); }
            else { setError((d && d.error) || '应用情绪失败'); }
          })
          .catch(function () { setError('应用情绪失败（Host 路由不可达）'); });
      }
      // manual 模式下把模型记下的「待定情绪」应用到立绘
      function applyPending() {
        var p = (cur && cur.pending) || null;
        if (!p) return;
        postApply({ emotion: p.emotion, intensity: p.intensity || 0, secondary: p.secondary || null });
      }
      // manual 模式下手动点选情绪直接应用
      function applyManual(emotion) {
        postApply({ emotion: emotion, intensity: 0 });
      }

      // 设置页操作：应用 + 立即持久化
      function updateStyle(patch) {
        applyStyle(patch);
        persistStyle();
      }

      function setSide(side) {
        var patch = { side: side };
        if (side === 'left') patch.x = 28;
        else if (side === 'right') patch.x = (window.innerWidth || 1200) - 28 - Math.round(style.size * 0.7);
        updateStyle(patch);
      }

      function chip(id, desc, active, onClick) {
        return react.createElement(
          'button',
          {
            type: 'button',
            onClick: function () { onClick(id); },
            style: {
              display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
              background: active ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid ' + (active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-border-l2)'),
              borderRadius: 12, padding: '9px 14px', marginBottom: 8,
              font: 'inherit', color: 'var(--dsw-alias-label-primary)'
            }
          },
          react.createElement('div', { style: { fontSize: 14, fontWeight: 500 } }, id),
          react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } }, desc)
        );
      }

      var activeId = cur && cur.character;
      var emoText = cur ? (cur.emotion || '—') + (cur.secondary ? ' + ' + cur.secondary : '') : '—';
      var mood = (cur && cur.mood) || { valence: 0, arousal: 0 };
      var mode = (cur && cur.mode) || 'auto';
      var activeChar = chars.find(function (c) { return c.id === activeId; });
      var activeEmotions = (activeChar && activeChar.emotions) || [];

      // ── 按钮样式（提前定义，模式卡片与样式卡片共用）──
      var btnStyle = {
        cursor: 'pointer', font: 'inherit', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8, padding: '5px 12px'
      };
      var btnActiveStyle = Object.assign({}, btnStyle, { borderColor: 'var(--dsw-alias-label-primary)' });

      var nodes = [
        react.createElement('h2', { key: 'head', style: { margin: '0 0 8px', fontSize: 16, fontWeight: 600 } }, '角色立绘'),
        react.createElement('p', { key: 'tip', style: { margin: '0 0 10px', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' } },
          '对话旁的立绘角色与情绪。图丢进插件目录 characters/<角色名>/（emotion.png / emotion-N.png 命名规律）后点「刷新角色」即识别；立绘可按住拖动、滚轮调大小。'),
      ];

      if (cur) {
        nodes.push(react.createElement('div', { key: 'now', style: { marginBottom: 12, padding: '10px 14px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)' } },
          react.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '当前'),
          react.createElement('div', { style: { fontSize: 16, fontWeight: 600, marginTop: 2 } },
            (cur.character || '?') + ' · ' + emoText),
          react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
            moodText(mood.valence),
            react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
              '· ' + arousalText(mood.arousal) + '（' + (mood.valence >= 0 ? '+' : '') + mood.valence + ' / ' + mood.arousal + '）')
          ),
          react.createElement('div', { style: { marginTop: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
            '心情 = 情绪倾向的连续值：正值偏开心、负值偏难过；唤醒 = 激动程度。情绪调用会推动心情，安静时慢慢回落。')
        ));
      }

      // ── 情绪模式卡片（v0.6.0 P0-1）──
      nodes.push(react.createElement('div', { key: 'mode', style: { marginBottom: 12, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)' } },
        react.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '情绪模式'),
        react.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          ['auto', 'manual', 'paused'].map(function (m) {
            return react.createElement('button', {
              key: m, type: 'button',
              style: mode === m ? btnActiveStyle : btnStyle,
              onClick: function () { setMode(m); }
            }, m === 'auto' ? '自动' : (m === 'manual' ? '手动' : '暂停'));
          })
        ),
        react.createElement('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
          mode === 'auto' ? '模型自动切图（默认）。'
            : mode === 'manual' ? '模型只记录待定情绪，手动点下方情绪应用。'
            : '完全冻结：任何情绪变化都不生效。'),
        mode === 'manual' && cur && cur.pending
          ? react.createElement('div', { key: 'pending', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)' } },
              react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
                '待定：' + cur.pending.emotion + (cur.pending.secondary ? ' + ' + cur.pending.secondary : '')),
              react.createElement('button', { type: 'button', style: btnActiveStyle, onClick: applyPending }, '应用'))
          : null,
        mode === 'manual' && activeEmotions.length > 0
          ? react.createElement('div', { key: 'manual', style: { marginTop: 8 } },
              react.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '手动应用情绪：'),
              react.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                activeEmotions.map(function (em) {
                  return react.createElement('button', {
                    key: em, type: 'button',
                    style: em === (cur && cur.pending && cur.pending.emotion) ? btnActiveStyle : btnStyle,
                    onClick: function () { applyManual(em); }
                  }, em);
                })))
          : null
      ));

      if (error) {
        nodes.push(react.createElement('div', { key: 'err', style: { marginBottom: 10, padding: '8px 12px', borderRadius: 10, fontSize: 13, color: 'var(--dsw-alias-state-danger-primary, #e5484d)', border: '1px solid var(--dsw-alias-state-danger-primary, #e5484d)', background: 'var(--dsw-alias-bg-layer-1)' } }, error));
      }

      nodes.push(react.createElement('div', { key: 'toolbar', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
        react.createElement('button', {
          type: 'button',
          onClick: refresh,
          style: {
            cursor: 'pointer', font: 'inherit', fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-3)',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8, padding: '5px 10px'
          }
        }, '🔃 刷新角色'),
        react.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
          chars.length + ' 个角色')
      ));

      if (chars.length === 0) {
        nodes.push(react.createElement('div', { key: 'empty', style: { padding: 12, borderRadius: 12, border: '1px dashed var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: '20px' } },
          '还没有可用角色。把立绘图放进 characters/<角色名>/ 后点「刷新角色」。'));
      } else {
        nodes.push(react.createElement('div', { key: 'list' },
          chars.map(function (c) {
            return chip(c.id, (c.emotions.length || 0) + ' 种情绪', activeId === c.id, pick);
          })
        ));
      }

      // ── 样式调节 ──
      nodes.push(react.createElement('div', { key: 'style', style: { marginTop: 14, padding: '12px 14px', borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)' } },
        react.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, '立绘样式'),

        react.createElement('div', { style: { marginBottom: 10 } },
          react.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '大小'),
            react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, style.size + ' px')
          ),
          react.createElement('input', {
            type: 'range', min: MIN_SIZE, max: MAX_SIZE, step: 10, value: style.size,
            onChange: function (e) { updateStyle({ size: parseInt(e.target.value, 10) || 260 }); },
            style: { width: '100%' }
          }),
          react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } },
            '也可以直接在立绘上滚动滚轮调整')
        ),

        react.createElement('div', { style: { marginBottom: 10 } },
          react.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '位置'),
          react.createElement('div', { style: { display: 'flex', gap: 8 } },
            react.createElement('button', { type: 'button', style: style.side === 'left' ? btnActiveStyle : btnStyle, onClick: function () { setSide('left'); } }, '靠左'),
            react.createElement('button', { type: 'button', style: style.side === 'right' ? btnActiveStyle : btnStyle, onClick: function () { setSide('right'); } }, '靠右')
          ),
          react.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } },
            '靠边后直接拖动立绘可自由摆放')
        ),

        react.createElement('div', { style: { marginBottom: 10 } },
          react.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
            react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '透明度'),
            react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, style.opacity + '%')
          ),
          react.createElement('input', {
            type: 'range', min: 30, max: 100, step: 5, value: style.opacity,
            onChange: function (e) { updateStyle({ opacity: parseInt(e.target.value, 10) || 100 }); },
            style: { width: '100%' }
          })
        ),

        react.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          react.createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '切换动画'),
          react.createElement('button', { type: 'button', style: style.animate ? btnActiveStyle : btnStyle, onClick: function () { updateStyle({ animate: !style.animate }); } },
            style.animate ? '开' : '关')
        )
      ));

      nodes.push(react.createElement('p', { key: 'hint', style: { margin: '10px 0 0', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' } },
        '模型回复时调用 set_expression 工具声明情绪（可带副情绪），立绘随之切换；情绪与心情相反时会自动缓冲降档。丢图/加角色后点「刷新角色」即可。'));

      return react.createElement('div', { key: 'char-emote', style: { padding: '4px 0', color: 'var(--dsw-alias-label-primary)' } }, nodes);
    }

    exports.inject = ['slots'];
    exports.apply = function (ctx) {
      fetchHostStyle();
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('shell.overlay', function () {
        return slots.register(
          {
            name: 'shell.overlay',
            id: 'char-emote-stand',
            order: 10,
            label: function () { return '角色立绘'; }
          },
          EmoteStand
        );
      });
      slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: 'char-emote',
            order: 120,
            label: function () { return '角色立绘'; }
          },
          function (props) { return react.createElement(EmoteSettings, { ctx: ctx }); }
        );
      });
    };

    module.exports = exports;
    return module.exports;
  }
});
