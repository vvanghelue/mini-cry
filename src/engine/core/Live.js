// Live channel: lets the agent CLI (`mc live ...`) drive a running game / editor tab through
// the dev server (SSE in, POST out). Commands are registered per app:
//   live.register('teleport', async (args) => result)
// Built-ins: eval (run JS with `app` in scope), screenshot (PNG data URL), ping, commands.
export class Live {
  constructor(kind, app) {
    this.kind = kind;
    this.app = app;
    this.commands = {
      ping: () => ({ kind, url: location.href, time: Date.now() }),
      commands: () => Object.keys(this.commands),
      eval: async ({ code }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function('app', 'THREE', `return (async () => { ${code.includes('return') ? code : 'return ' + code} })()`);
        return fn(this.app, this.app.THREE);
      },
      screenshot: async ({ width } = {}) => {
        const engine = this.app.engine;
        engine.render();
        let url = engine.canvas.toDataURL('image/png');
        if (width) {
          const img = new Image();
          img.src = url;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = width; c.height = Math.round((img.height / img.width) * width);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          url = c.toDataURL('image/png');
        }
        return { dataUrl: url };
      },
    };
    if (!import.meta.env?.DEV) return;
    this.connect();
  }

  register(name, fn) { this.commands[name] = fn; }

  connect() {
    const es = new EventSource(`/api/live/events?kind=${this.kind}`);
    es.addEventListener('cmd', async (ev) => {
      const { id, cmd, args } = JSON.parse(ev.data);
      let result, error;
      try {
        const fn = this.commands[cmd];
        if (!fn) throw new Error(`unknown command "${cmd}" (available: ${Object.keys(this.commands).join(', ')})`);
        result = await fn(args ?? {});
      } catch (e) {
        error = String(e?.stack ?? e);
      }
      let body;
      try { body = JSON.stringify({ id, result, error }); }
      catch { body = JSON.stringify({ id, result: String(result), error }); }
      fetch('/api/live/result', { method: 'POST', body }).catch(() => {});
    });
    es.onerror = () => {}; // auto-reconnects
    this.es = es;
  }
}
