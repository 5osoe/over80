--- START OF FILE app.js ---

/** 
 * --- CONFIG & LANGUAGE --- 
 */
const CONFIG = {
    maxSpeed: 80,
    laneCount: 4,
    gravity: 12,
    accel: 0.8
};

/** 
 * --- STATE & VARIABLES --- 
 */
let state = {
    mode: 'MENU',
    coins: parseInt(localStorage.getItem('rush80_coins')) || 0,
    best: parseInt(localStorage.getItem('rush80_best')) || 0,
    inventory: JSON.parse(localStorage.getItem('rush80_inv')) || { turbo: false, shield: false, double: false, traffic: false },
    
    // Extended Save System Data
    score: parseInt(localStorage.getItem('rush80_score')) || 0,
    ring: parseInt(localStorage.getItem('rush80_ring')) || 0,
    hearts: parseInt(localStorage.getItem('rush80_hearts')) || 5,
    coinBuffer: parseInt(localStorage.getItem('rush80_coinBuffer')) || 0,
    
    // Phase 3 & 4: Combat & Boss
    combatMode: false,
    bossActive: false, 
    bossCount: parseInt(localStorage.getItem('rush80_bossCount')) || 0, 
    monstersKilled: 0,
    
    speed: 0,
    lane: 1, // 0 to 3
    doubleTimer: 0,
    runtime: 0,
    paused: false
};

let player = { visualX: 0, y: 0, w: 0, h: 0, tilt: 0 };
let traffic = [];
let particles = [];
let bullets = []; 
let monsters = []; 
let roadOffset = 0;
let lastTime = 0;
let spawnTimer = 0;
let fireTimer = 0;
const FIRE_RATE = 0.25; 

/** 
 * --- PHASE 1 FUNCTIONS --- 
 */

function updateHeartsUI(){
    const el = document.getElementById("hearts-ui");
    if(!el) return;

    el.innerHTML = "";
    for(let i=0;i<state.hearts;i++){
        const heart = document.createElement("div");
        heart.className = "pixel-heart";
        el.appendChild(heart);
    }
}

function updateRingUI(){
    const el = document.getElementById("ring-ui");
    if(el){
        // CLEAN UI: Just numbers
        el.innerText = state.ring;
    }
}

function checkRingProgress(){
    const nextCheckpoint = (state.ring + 1) * 5000;
  
    // STABILITY FIX: Prevent Ring Trigger During Combat
    if(!state.combatMode && state.score >= nextCheckpoint){
        state.ring += 1;
        state.score = 0; // RESET SCORE AFTER RING
        document.getElementById('ui-score').innerText = state.score;
        updateRingUI();
        saveData();
        enterCombat(); // Trigger Combat
    }
}

/** 
 * --- PHASE 3 & 4: COMBAT & BOSS SYSTEM --- 
 */
function enterCombat(){
    state.combatMode = true;
    state.bossActive = false;
    state.speed = 50;
    monsters = [];
    state.monstersKilled = 0;

    // Phase 4: Boss every 5 rings
    if(state.ring > 0 && (state.ring % 5) === 0){
        spawnBoss();
    } else {
        spawnMonsterWave();
    }
}

function spawnMonsterWave(){
    for(let i=0;i<10;i++){
        const lane = Math.floor(Math.random()*CONFIG.laneCount);
        const hpType = Math.random();

        let hp = 3;
        if(hpType > 0.66) hp = 7;
        else if(hpType > 0.33) hp = 5;

        monsters.push({
            lane: lane,
            x: 0, 
            y: -200 - (i*120),
            w: player.w,
            h: player.h,
            hp: hp,
            boss: false
        });
    }
}

function spawnBoss(){
    state.bossActive = true;

    monsters.push({
        lane: Math.floor(CONFIG.laneCount/2), // Center(ish)
        x: 0,
        y: -250,
        w: player.w * 1.4,
        h: player.h * 1.4,
        hp: 20,
        boss: true
    });
}

/** 
 * --- BULLET SYSTEM --- 
 */
function spawnBullet(){
    bullets.push({
        x: player.visualX + player.w/2 - 3,
        y: player.y,
        w: 6,
        h: 12,
        speed: 500
    });
}

/** 
 * --- AUDIO --- 
 */
const Audio = {
    ctx: null, 
    engineNode: null, 
    engineOsc: null,
    engineGain: null,
    masterGain: null,

    init: function() {
        if (this.ctx) return;
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);

        // Brown Noise Buffer for texture
        const bufSize = this.ctx.sampleRate * 2;
        const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        let lastOut = 0;
        for (let i = 0; i < bufSize; i++) {
            const white = Math.random() * 2 - 1;
            data[i] = (lastOut + (0.02 * white)) / 1.02;
            lastOut = data[i];
            data[i] *= 3.5; // Compensate gain
        }

        // Engine Noise Source
        this.engineNode = this.ctx.createBufferSource();
        this.engineNode.buffer = buf;
        this.engineNode.loop = true;
        
        // Engine Hum Source (Sine for depth)
        this.engineOsc = this.ctx.createOscillator();
        this.engineOsc.type = 'sine';
        this.engineOsc.frequency.value = 60;

        // Mixer
        this.engineGain = this.ctx.createGain();
        this.engineGain.gain.value = 0;

        // Filter
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = 80;

        // Connections
        this.engineNode.connect(this.filter);
        this.engineOsc.connect(this.engineGain); // Mix oscillating hum
        this.filter.connect(this.engineGain);
        this.engineGain.connect(this.masterGain);

        this.engineNode.start();
        this.engineOsc.start();
    },
    
    resume: function() { 
        if(this.ctx && this.ctx.state==='suspended') this.ctx.resume(); 
    },
    
    updateEngine: function(ratio) {
        if(!this.ctx) return;
        
        const isPlaying = (state.mode==='PLAY' && !state.paused);
        // REFINED ENGINE SOUND
        const targetVol = isPlaying ? 0.12 + (ratio * 0.18) : 0;
        
        // Frequencies
        const humFreq = 60 + (ratio * 120); 
        const filterFreq = 120 + (ratio * 600); 
        
        const t = this.ctx.currentTime;
        this.engineGain.gain.setTargetAtTime(targetVol, t, 0.1);
        this.engineOsc.frequency.setTargetAtTime(humFreq, t, 0.1);
        this.filter.frequency.setTargetAtTime(filterFreq, t, 0.1);
    },
    
    sfx: function(type) {
        if (!this.ctx) this.init();
        this.resume();
        
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.connect(g);
        g.connect(this.masterGain);

        if(type === 'click') {
            osc.frequency.setValueAtTime(800, t);
            osc.frequency.exponentialRampToValueAtTime(1200, t+0.05);
            g.gain.setValueAtTime(0.1, t);
            g.gain.exponentialRampToValueAtTime(0.01, t+0.05);
            osc.start(t); osc.stop(t+0.05);
        } else if (type === 'coin') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(500, t);
            osc.frequency.linearRampToValueAtTime(1200, t + 0.12);
            g.gain.setValueAtTime(0.08, t);
            g.gain.linearRampToValueAtTime(0, t + 0.12);
            osc.start(t); osc.stop(t + 0.12);
        } else if (type === 'crash') {
            // Crash
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(100, t);
            osc.frequency.exponentialRampToValueAtTime(10, t+0.4);
            g.gain.setValueAtTime(0.3, t);
            g.gain.exponentialRampToValueAtTime(0.01, t+0.4);
            osc.start(t); osc.stop(t+0.4);
        } else if (type === 'score') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(700, t);
            osc.frequency.linearRampToValueAtTime(900, t + 0.06);
            g.gain.setValueAtTime(0.05, t);
            g.gain.linearRampToValueAtTime(0, t + 0.06);
            osc.start(t); 
            osc.stop(t + 0.06);
        } else if (type === 'move') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(300, t);
            osc.frequency.linearRampToValueAtTime(500, t + 0.05);
            g.gain.setValueAtTime(0.04, t);
            g.gain.linearRampToValueAtTime(0, t + 0.05);
            osc.start(t); 
            osc.stop(t + 0.05);
        }
    }
};

/** 
 * --- CORE GRAPHICS --- 
 */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
let width, height, laneWidth;

function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = document.getElementById('game-wrapper').getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    
    laneWidth = width / CONFIG.laneCount;
    
    player.w = width * 0.11;
    player.h = player.w * 1.5;
    player.y = height * 0.75;
    
    if(state.mode !== 'PLAY') {
        player.visualX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    }
}

function loop(now) {
    if(!lastTime) lastTime = now;
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    
    if(dt > 0.1) dt = 0.016; 
    
    if (state.mode === 'PLAY') {
        if (!state.paused) update(dt);
        else Audio.updateEngine(0);
    }
    
    draw();
    requestAnimationFrame(loop);
}

function update(dt) {
    if (state.paused) return;
    if (!laneWidth) resize();

    state.runtime += dt;
    
    // 1. Acceleration (Phase 4 Logic)
    let targetSpeed = CONFIG.maxSpeed;
    if(state.combatMode && !state.bossActive){
        targetSpeed = 50;
    }
    if(state.bossActive){
        targetSpeed = 40;
    }

    const accel = state.inventory.turbo ? 1.2 : 0.8;
    state.speed += (targetSpeed - state.speed) * accel * dt;
    
    // 2. Player Movement
    const targetX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    const lerpSpeed = 12;
    player.visualX += (targetX - player.visualX) * lerpSpeed * dt;
    player.tilt = (targetX - player.visualX) * 0.08;

    // 3. Traffic Spawning (STABILITY FIX: Stop during combat)
    spawnTimer += dt;
    if (!state.combatMode && spawnTimer > 0.45) { 
        spawnTimer = 0;
        if (state.runtime > 1.5) {
            const chance = state.inventory.traffic ? 0.30 : 0.65;
            if (Math.random() < chance) spawnTraffic();
        }
    }

    // 4. Traffic & Collision
    const moveSpeed = 100 + (state.speed * 8);
    roadOffset = (roadOffset + moveSpeed * dt) % 40;

    for (let i = traffic.length - 1; i >= 0; i--) {
        let t = traffic[i];
        t.y += (moveSpeed * 0.8) * dt; 

        if (!t.passed && t.y > player.y + player.h) {
            t.passed = true;
            addScore();
        }

        if (t.y > height + 50) {
            traffic.splice(i, 1);
        } else {
            const pad = 8;
            if (player.visualX < t.x + t.w - pad &&
                player.visualX + player.w > t.x + pad &&
                player.y < t.y + t.h - pad &&
                player.y + player.h > t.y + pad) {
                crash(t);
            }
        }
    }

    // 5. Phase 3 & 4: Monster/Boss Updates
    if(state.combatMode){
        for(let i = monsters.length - 1; i >= 0; i--){
            const m = monsters[i];

            m.x = (m.lane * laneWidth) + (laneWidth/2) - (m.w/2);
            m.y += 200 * dt;

            // CRITICAL FIX 1: Direct Collision with Player
            const pad = 6;
            if(
                player.visualX < m.x + m.w - pad &&
                player.visualX + player.w > m.x + pad &&
                player.y < m.y + m.h - pad &&
                player.y + player.h > m.y + pad
            ){
                state.hearts--;
                updateHeartsUI();
                monsters.splice(i,1);

                if(state.hearts <= 0){
                    state.mode = 'OVER';
                    state.paused = false;
                    if(state.score > state.best) state.best = state.score;
                    saveData();
                    
                    document.getElementById('go-score').innerText = state.score;
                    document.getElementById('go-coins').innerText = state.coins;
                    
                    showScreen('gameover-screen');
                    document.getElementById('btn-pause').style.display = 'none';
                }

                continue;
            }

            // Bullet collision
            for(let j = bullets.length - 1; j >= 0; j--){
                const b = bullets[j];

                if(b.x < m.x + m.w &&
                   b.x + b.w > m.x &&
                   b.y < m.y + m.h &&
                   b.y + b.h > m.y){

                    m.hp -= 1;
                    bullets.splice(j,1);

                    // Monster / Boss Death Logic
                    if(m.hp <= 0){
                        if(m.boss){
                            state.bossCount++;
                            // Progressive Reward
                            const reward = 75 + ((state.bossCount-1) * 100);
                            state.score += reward;
                            // CRITICAL FIX 3: Save after boss death
                            saveData();
                        } else {
                            state.score += 10;
                            state.monstersKilled++;
                        }
                        
                        document.getElementById('ui-score').innerText = state.score;
                        monsters.splice(i,1);
                        break;
                    }
                }
            }

            // Monster Passed Player Logic (Damage)
            if(m && m.y > player.y + player.h){
                if(m.boss){
                    state.score -= 100;
                } else {
                    state.score -= 20;
                }
                
                document.getElementById('ui-score').innerText = state.score;
                monsters.splice(i,1);
            }
        }

        // Combat Exit Conditions (Wave or Boss)
        if(!state.bossActive && state.monstersKilled >= 10){
            state.combatMode = false;
            state.speed = CONFIG.maxSpeed;
            monsters = [];
        }

        if(state.bossActive && monsters.length === 0){
            state.combatMode = false;
            state.bossActive = false;
            state.speed = CONFIG.maxSpeed;
        }
    }

    // 6. Particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.life -= dt * 2.5;
        if(p.life <= 0) particles.splice(i, 1);
    }

    // 7. Timers
    if (state.doubleTimer > 0) state.doubleTimer -= dt;
    
    // 8. Auto Fire & Bullets
    // STABILITY FIX: Limit Auto Fire to Combat Only & Active Monsters
    if(state.mode === 'PLAY' && !state.paused && state.combatMode && monsters.length > 0){
        fireTimer += dt;

        if(fireTimer >= FIRE_RATE){
            fireTimer = 0;

            if(state.coins > 0){
                spawnBullet();
                state.coins -= 1;
                updateCoinHUD();
            }
        }
    }

    for(let i = bullets.length - 1; i >= 0; i--){
        bullets[i].y -= bullets[i].speed * dt;

        if(bullets[i].y < -20){
            bullets.splice(i,1);
        }
    }
    
    // UI Updates
    Audio.updateEngine(state.speed / CONFIG.maxSpeed);
    document.getElementById('ui-speed').innerText = Math.floor(state.speed);
}

function spawnTraffic() {
    const l = Math.floor(Math.random() * CONFIG.laneCount);
    const x = (l * laneWidth) + (laneWidth/2) - (player.w/2);
    
    // Anti-stacking
    for(let t of traffic) {
        if (Math.abs(t.x - x) < 5 && t.y < -220) return;
    }

    traffic.push({
        x: x,
        y: -250, 
        w: player.w,
        h: player.h,
        passed: false
    });
}

function addScore() {
    const pts = 20; 
    state.score += pts;
    
    // AUDIO CHANGE: NO SOUND HERE FOR TRAFFIC PASS
    // Audio.sfx('score'); REMOVED

    state.coinBuffer += pts;
    while (state.coinBuffer >= 100) { 
        state.coinBuffer -= 100;
        state.coins += 5;
        // AUDIO CHANGE: SOUND HERE WHEN COINS EARNED
        Audio.sfx('coin'); 
        updateCoinHUD();
        saveData();
    }

    checkRingProgress();
    document.getElementById('ui-score').innerText = state.score;
}

// HEART SYSTEM CORRECTION PATCH
function crash(t) {

    // If shield active, absorb crash
    if (state.inventory.shield) {
        state.inventory.shield = false;
        shakeScreen(10);
        Audio.sfx('crash');
        explode(t.x + t.w/2, t.y + t.h/2);
        t.y = height + 500;
        return;
    }

    // Lose one heart instead of instant game over
    state.hearts--;
    updateHeartsUI();
    shakeScreen(15);
    Audio.sfx('crash');
    explode(player.visualX + player.w/2, player.y + player.h/2);

    // Remove the traffic car
    t.y = height + 500;

    // If no hearts left → Game Over
    if(state.hearts <= 0){
        state.mode = 'OVER';
        state.paused = false;

        if (state.score > state.best) state.best = state.score;

        saveData();

        document.getElementById('go-score').innerText = state.score;
        document.getElementById('go-coins').innerText = state.coins;

        showScreen('gameover-screen');
        document.getElementById('btn-pause').style.display = 'none';
    }
}

/** 
 * --- VISUALS --- 
 */
let shakeAmt = 0;
function shakeScreen(a) { shakeAmt = a; }

function explode(x, y) {
    for(let i=0; i<20; i++) {
        particles.push({
            x:x, y:y, 
            vx:(Math.random()-0.5)*20, 
            vy:(Math.random()-0.5)*20, 
            life:1, size:Math.random()*6+2
        });
    }
}

function draw() {
    // Fixed Light Mode Colors
    const cRoad = '#dcdcdc';
    const cShoulder = '#cfcfcf';
    const cLane = 'rgba(0, 0, 0, 0.35)';
    const cCar = '#111111';
    const cDetail = '#e5e5e5';
    const cAccent = '#cc0000';

    // 1. Draw Road Base
    ctx.fillStyle = cRoad;
    ctx.fillRect(0, 0, width, height);

    // 2. Draw Shoulders
    ctx.fillStyle = cShoulder;
    ctx.fillRect(0, 0, width * 0.05, height);
    ctx.fillRect(width * 0.95, 0, width * 0.05, height);
    
    ctx.save();
    
    // 3. Shake
    let sx=0, sy=0;
    if (shakeAmt > 0) {
        const limit = Math.min(shakeAmt, 15);
        sx = (Math.random()-0.5) * limit; 
        sy = (Math.random()-0.5) * limit;
        shakeAmt *= 0.9;
        if(shakeAmt < 0.5) shakeAmt = 0;
    }
    ctx.translate(sx, sy);

    // 4. Road Lines
    ctx.strokeStyle = cLane;
    ctx.lineWidth = 2;
    ctx.setLineDash([30, 40]);
    ctx.lineDashOffset = -roadOffset;
    ctx.beginPath();
    for(let i=1; i<CONFIG.laneCount; i++) {
        let x = i * laneWidth;
        ctx.moveTo(x, 0); ctx.lineTo(x, height);
    }
    ctx.stroke();

    function drawCar(x, y, w, h, col, isPlayer) {
        ctx.save();
        if (isPlayer) {
            ctx.translate(x + w/2, y + h/2);
            ctx.rotate(player.tilt * 0.003); 
            ctx.translate(-(x + w/2), -(y + h/2));
        }
        
        ctx.fillStyle = col;
        ctx.fillRect(x, y, w, h);
        
        // Details
        ctx.fillStyle = cDetail;
        ctx.fillRect(x+2, y+h*0.15, w-4, h*0.15); // Windshield
        ctx.fillRect(x+2, y+h*0.75, w-4, h*0.1);  // Rear window
        
        if (isPlayer) {
            ctx.fillStyle = cAccent;
            ctx.fillRect(x+2, y+h-5, 5, 3); // Lights
            ctx.fillRect(x+w-7, y+h-5, 5, 3);
        }
        
        ctx.restore();
    }

    if (state.mode !== 'OVER') {
        drawCar(player.visualX, player.y, player.w, player.h, cCar, true);
        if (state.inventory.shield) {
            ctx.strokeStyle = cAccent;
            ctx.strokeRect(player.visualX-4, player.y-4, player.w+8, player.h+8);
        }
        
        // Draw Bullets
        bullets.forEach(b=>{
            ctx.fillStyle = '#cc0000';
            ctx.fillRect(b.x, b.y, b.w, b.h);
        });

        // Draw Monsters
        if(state.combatMode){
            monsters.forEach(m=>{
                ctx.fillStyle = m.boss ? '#880000' : '#000'; // Boss is darker red/black
                ctx.fillRect(m.x, m.y, m.w, m.h);
            });
        }
    }

    traffic.forEach(t => drawCar(t.x, t.y, t.w, t.h, cCar, false));

    particles.forEach(p => {
        ctx.fillStyle = p.life > 0.5 ? cAccent : cCar;
        ctx.globalAlpha = p.life;
        ctx.fillRect(p.x, p.y, p.size, p.size);
    });

    ctx.restore();
}

/** 
 * --- INPUT & SYSTEM --- 
 */
function move(dir) {
    if (state.mode !== 'PLAY' || state.paused) return;
    Audio.resume();
    
    state.lane += dir;
    if(state.lane < 0) state.lane = 0;
    if(state.lane >= CONFIG.laneCount) state.lane = CONFIG.laneCount - 1;
    Audio.sfx('move');
}

window.addEventListener('keydown', e => {
    if(e.key==='ArrowLeft') move(-1);
    if(e.key==='ArrowRight') move(1);
    if(e.key.toLowerCase()==='p') togglePause();
});

document.getElementById('touch-area').addEventListener('touchstart', (e) => {
    e.preventDefault();
    if(e.target.id === 'btn-pause') return;
    if(state.mode !== 'PLAY' || state.paused) return;
    
    const touchX = e.touches[0].clientX;
    const centerX = window.innerWidth / 2;
    
    if (touchX < centerX) move(-1);
    else move(1);
}, { passive: false });

document.getElementById('btn-pause').addEventListener('click', function(e){
    e.stopPropagation();
    e.preventDefault();
    togglePause();
});

window.startGame = () => {
    Audio.sfx('click');
    Audio.init(); Audio.resume();
    
    state.mode = 'PLAY';
    state.paused = false;
    state.speed = 20;
    // state.score = 0; REMOVED
    state.runtime = 0;
    state.lane = 1;
    
    // Reset Session Stats
    state.hearts = 5; 
    // state.ring = 0; REMOVED
    // state.coinBuffer = 0; REMOVED
    
    // Reset Phase 3 & 4
    state.combatMode = false;
    state.bossActive = false;
    state.bossCount = 0; 
    state.monstersKilled = 0;
    monsters = [];
    
    // SAVE ON RESET
    saveData();

    state.doubleTimer = state.inventory.double ? 30 : 0;
    if (state.inventory.turbo) state.speed = 40;
    
    traffic = [];
    particles = [];
    bullets = [];
    fireTimer = 0;
    
    resize();
    player.visualX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    
    showScreen(null);
    updateCoinHUD();
    updateHeartsUI();
    updateRingUI();
    
    document.getElementById('pause-overlay').classList.remove('visible');
    document.getElementById('btn-pause').style.display = 'flex';
};

window.togglePause = () => {
    if(state.mode !== 'PLAY') return;
    state.paused = !state.paused;
    const overlay = document.getElementById('pause-overlay');
    
    if(state.paused) {
        Audio.sfx('click');
        overlay.classList.add('visible');
        Audio.updateEngine(0);
    } else {
        Audio.resume();
        overlay.classList.remove('visible');
    }
};

function saveData() {
    localStorage.setItem('rush80_coins', state.coins);
    localStorage.setItem('rush80_best', state.best);
    localStorage.setItem('rush80_inv', JSON.stringify(state.inventory));
    
    // Extended Save
    localStorage.setItem('rush80_score', state.score);
    localStorage.setItem('rush80_ring', state.ring);
    localStorage.setItem('rush80_hearts', state.hearts);
    localStorage.setItem('rush80_coinBuffer', state.coinBuffer);
    localStorage.setItem('rush80_bossCount', state.bossCount);
}

function updateCoinHUD() {
    const el = document.getElementById('ui-coins-live');
    if(el) el.innerText = state.coins;
}

function updateShop() {
    document.getElementById('shop-coins').innerText = state.coins;
    ['turbo','shield','double','traffic'].forEach(k => {
        const el = document.querySelector(`.shop-item[onclick*="${k}"]`);
        if(state.inventory[k]) {
            el.classList.add('owned');
            el.querySelector('.price-tag').innerText = "✔";
        }
    });
}

window.showScreen = (id) => { 
    Audio.sfx('click');
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    if(id) {
        document.getElementById(id).classList.remove('hidden');
        if(id==='shop-screen') updateShop();
        if(id==='start-screen') {
            document.getElementById('ui-best').innerText = state.best;
            document.getElementById('ui-coins').innerText = state.coins;
            updateCoinHUD();
            document.getElementById('btn-pause').style.display = 'none';
        }
    }
};

window.buyItem = (item, price) => {
    if(state.inventory[item]) return;
    if(state.coins >= price) {
        Audio.sfx('click');
        state.coins -= price;
        state.inventory[item] = true;
        saveData();
        updateShop();
        updateCoinHUD();
    }
};

// AUDIO SAFETY
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        if(state.mode === 'PLAY') state.paused = true;
        if(Audio && Audio.ctx) Audio.ctx.suspend();
    } else {
        if(Audio && Audio.ctx && !state.paused) Audio.ctx.resume();
    }
});

window.addEventListener("blur", () => {
    if(state.mode === 'PLAY') state.paused = true;
    if (Audio && Audio.ctx) Audio.ctx.suspend();
});

// SERVICE WORKER REGISTRATION
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js");
  });
}

// Init
window.addEventListener('resize', resize);
document.getElementById('ui-best').innerText = state.best;
document.getElementById('ui-coins').innerText = state.coins;
updateCoinHUD();
document.getElementById('btn-pause').style.display = 'none';
resize();
requestAnimationFrame(loop);