// Menus: main menu, pause, settings, death screen, full-screen map (with fast travel), end screen.
const h = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
};

export class Menus {
  constructor(game) {
    this.game = game;
    this.root = h('div', 'menus', document.body);
    this.panel = h('div', 'menu-panel', this.root);
    this.mapEl = h('div', 'map-screen', document.body);
    this.mapCanvas = h('canvas', '', this.mapEl);
    this.mapInfo = h('div', 'map-info', this.mapEl);
    this.mapOpen = false;
    this.mapCanvas.addEventListener('click', (e) => this._mapClick(e));
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.mapOpen) { e.preventDefault(); this.toggleMap(); }
    });
  }

  hideAll() { this.root.classList.remove('show'); }

  _show(html, actions) {
    this.panel.innerHTML = html;
    for (const [sel, fn] of Object.entries(actions ?? {})) this.panel.querySelector(sel)?.addEventListener('click', (e) => { this.game.audio?.resume?.(); this.game.audio?.play('ui_click', { volume: 0.4 }); fn(e); });
    this.root.classList.add('show');
  }

  showMain() {
    const g = this.game;
    const cont = g.hasSave() || g.params.has('continue');
    if (g.params.has('continue')) { setTimeout(() => g.newGame({ fromCheckpoint: true }), 0); return; }
    this._show(`
      <div class="logo">MINI <span>CRY</span></div>
      <div class="tag">Isla Sombra — un FPS en monde ouvert low-poly</div>
      <button class="b-new">Nouvelle partie</button>
      ${cont ? '<button class="b-cont">Continuer</button>' : ''}
      <button class="b-opt">Options</button>
      <button class="b-edit">Éditeur</button>
      <div class="help">ZQSD/WASD se déplacer · Souris viser · Clic tirer · Clic droit viser · R recharger · E utiliser · G grenade · V coup de machette · Maj sprint · Ctrl accroupi · Espace sauter · B jumelles · M carte · 1-5 armes</div>
      <div class="load">${g.loadMs ? `Chargé en ${(g.loadMs / 1000).toFixed(1)} s` : ''}</div>`, {
      '.b-new': () => { try { localStorage.removeItem('minicry.save.v1'); } catch { /* */ } g.newGame(); },
      '.b-cont': () => g.newGame({ fromCheckpoint: true }),
      '.b-opt': () => this.showSettings(() => this.showMain()),
      '.b-edit': () => (location.href = '/editor.html'),
    });
  }

  showPause() {
    const g = this.game;
    const s = g.stats;
    this._show(`
      <div class="title">PAUSE</div>
      <button class="b-res">Reprendre</button>
      <button class="b-map">Carte</button>
      <button class="b-cp">Recharger le dernier point de contrôle</button>
      <button class="b-opt">Options</button>
      <button class="b-quit">Menu principal</button>
      <div class="stats">Tués ${s.kills} · Éliminations furtives ${s.takedowns} · Précision ${s.shots ? Math.round((s.hits / s.shots) * 100) : 0}% · Avant-postes ${g.liberated.size}</div>`, {
      '.b-res': () => g.resume(),
      '.b-map': () => { this.hideAll(); this.toggleMap(); },
      '.b-cp': () => g.loadCheckpoint(),
      '.b-opt': () => this.showSettings(() => this.showPause()),
      '.b-quit': () => (location.href = location.pathname),
    });
  }

  showDeath() {
    const g = this.game;
    this._show(`
      <div class="title red">MORT</div>
      <button class="b-cp">Reprendre au dernier point de contrôle</button>
      <button class="b-quit">Menu principal</button>`, {
      '.b-cp': () => (g.hasSave() ? g.loadCheckpoint() : location.reload()),
      '.b-quit': () => (location.href = location.pathname),
    });
  }

  showEnd(a = {}) {
    const g = this.game, s = g.stats;
    this._show(`
      <div class="title">${a.title ?? 'FIN'}</div>
      <div class="tag">${a.text ?? 'Isla Sombra est libre.'}</div>
      <div class="stats">Temps ${Math.round(s.playTime / 60)} min · Tués ${s.kills} · Tirs à la tête ${s.headshots} · Éliminations furtives ${s.takedowns} · Avant-postes ${g.liberated.size} · Reliques ${g.collected.relic ?? 0}</div>
      <button class="b-free">Continuer à explorer</button>
      <button class="b-quit">Menu principal</button>`, {
      '.b-free': () => { g.started = true; g.resume(); },
      '.b-quit': () => (location.href = location.pathname),
    });
  }

  showSettings(back) {
    const g = this.game, s = g.settings;
    this._show(`
      <div class="title">OPTIONS</div>
      <label>Qualité <select name="quality">${['low', 'medium', 'high', 'ultra'].map((q) => `<option ${q === s.quality ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
      <label>Occlusion ambiante (SSAO) <input name="ao" type="checkbox" ${s.ao !== false ? 'checked' : ''}></label>
      <label>Reflets du soleil (lens flare) <input name="flare" type="checkbox" ${s.flare !== false ? 'checked' : ''}></label>
      <label>Difficulté <select name="difficulty">${['facile', 'normal', 'difficile'].map((q) => `<option ${q === s.difficulty ? 'selected' : ''}>${q}</option>`).join('')}</select></label>
      <label>Sensibilité souris <input name="sensitivity" type="range" min="0.3" max="2.5" step="0.05" value="${s.sensitivity}"></label>
      <label>Champ de vision <input name="fov" type="range" min="60" max="95" step="1" value="${s.fov}"></label>
      <label>Inverser l'axe Y <input name="invertY" type="checkbox" ${s.invertY ? 'checked' : ''}></label>
      <label>Volume <input name="volume" type="range" min="0" max="1" step="0.05" value="${s.volume}"></label>
      <label>Musique <input name="music" type="range" min="0" max="1" step="0.05" value="${s.music}"></label>
      <label>Voix des dialogues <input name="voices" type="checkbox" ${s.voices ? 'checked' : ''}></label>
      <label>Volume des voix <input name="voiceVolume" type="range" min="0" max="1.5" step="0.05" value="${s.voiceVolume ?? 1}"></label>
      <label>Afficher les performances (F3) <input name="perf" type="checkbox" ${document.getElementById('perf')?.hidden === false ? 'checked' : ''}></label>
      <button class="b-back">Retour</button>`, {
      '.b-back': () => back(),
    });
    this.panel.querySelectorAll('input, select').forEach((inp) => inp.addEventListener('input', () => {
      if (inp.name === 'perf') { g.app.perf?.setVisible(inp.checked); return; }
      const v = inp.type === 'checkbox' ? inp.checked : inp.type === 'range' ? Number(inp.value) : inp.value;
      g.saveSettings({ [inp.name]: v });
    }));
  }

  // --- map ---------------------------------------------------------------------------------
  toggleMap() {
    const g = this.game;
    this.mapOpen = !this.mapOpen;
    this.mapEl.classList.toggle('show', this.mapOpen);
    if (this.mapOpen) {
      this.hideAll();
      g.input.unlock();
      g.engine.timeScale = 0;
      this._drawMap();
    } else if (g.paused) {
      // opened from the pause menu: go back to it (Escape is not a user gesture, the pointer
      // lock the player released with Escape can't be taken back from it)
      this.showPause();
    } else if (g.started && g.player.alive) {
      g.engine.timeScale = g.cheats.timeScale;
      g.input.lock();
    }
  }

  _drawMap() {
    const g = this.game, T = g.world.terrain;
    const size = Math.min(innerWidth, innerHeight) * 0.86;
    const c = this.mapCanvas;
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(g.hud.mapImage, 0, 0, size, size);
    const k = size / T.size;
    const px = (x) => (x + T.half) * k;
    this._fast = [];
    // labels from markers with a map label
    ctx.font = 'bold 13px Trebuchet MS';
    ctx.textAlign = 'center';
    for (const e of g.world.entities.list) {
      if (e.type === 'marker' && e.label) { ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillText(e.label, px(e.pos[0]) + 1, px(e.pos[2]) + 1); ctx.fillStyle = '#fff'; ctx.fillText(e.label, px(e.pos[0]), px(e.pos[2])); }
      if (e.type === 'outpost') {
        const lib = g.liberated.has(e.id);
        ctx.fillStyle = lib ? '#3fb0ff' : '#e03030';
        ctx.beginPath(); ctx.arc(px(e.pos[0]), px(e.pos[2]), 7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.fillText(e.name ?? 'Avant-poste', px(e.pos[0]), px(e.pos[2]) - 12);
        if (lib && e.fastTravel !== false) this._fast.push({ id: e.id, x: px(e.pos[0]), y: px(e.pos[2]) });
      }
    }
    for (const m of g.missions.markers()) {
      ctx.fillStyle = '#ffd34d'; ctx.strokeStyle = '#000';
      const x = px(m.x), y = px(m.z);
      ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    for (const a of g.actors.list) {
      if (!a.alive || !(a.tagged || a.ai?.state === 'combat')) continue;
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath(); ctx.arc(px(a.pos.x), px(a.pos.z), 3, 0, Math.PI * 2); ctx.fill();
    }
    // player arrow
    const p = g.player;
    ctx.save();
    ctx.translate(px(p.pos.x), px(p.pos.z));
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    const m = g.missions.focus && g.missions.defs.get(g.missions.focus);
    this.mapInfo.innerHTML = `<b>${m?.title ?? 'Exploration libre'}</b><br>${m ? (m.objectives[g.missions.state[m.id]?.obj]?.text ?? '') : ''}<br><small>${this._fast.length ? 'Cliquez sur un avant-poste libéré (bleu) pour y voyager.' : 'Libérez des avant-postes pour débloquer le voyage rapide.'} · M / Échap pour fermer</small>`;
  }

  _mapClick(e) {
    const r = this.mapCanvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const f = (this._fast ?? []).find((o) => Math.hypot(o.x - x, o.y - y) < 12);
    if (f) {
      this.toggleMap();
      this.game.fastTravel(f.id);
      if (this.game.paused) this.game.resume(); // the click is a user gesture: the pointer lock comes back
    }
  }
}
