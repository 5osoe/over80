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
    coinBuffer: 0,
    
    speed: 0,
    score: 0,
    lane: 1, // 0 to 3
    combo: 1,
    lastComboTime: 0,
    doubleTimer: 0,
    runtime: 0,
    paused: false
};

let player = { visualX: 0, y: 0, w: 0, h: 0, tilt: 0 };
let traffic = [];
let particles = [];
let roadOffset = 0;
let lastTime = 0;
let spawnTimer = 0;

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
        const targetVol = isPlaying ? 0.08 + (ratio * 0.15) : 0;
        
        // Frequencies
        const humFreq = 40 + (ratio * 80); // 40Hz to 120Hz
        const filterFreq = 80 + (ratio * 420); // 80Hz to 500Hz
        
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
    
    // 1. Acceleration
    const targetSpeed = CONFIG.maxSpeed;
    const accel = state.inventory.turbo ? 1.2 : 0.8;
    state.speed += (targetSpeed - state.speed) * accel * dt;
    
    // 2. Player Movement
    const targetX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    const lerpSpeed = 12;
    player.visualX += (targetX - player.visualX) * lerpSpeed * dt;
    player.tilt = (targetX - player.visualX) * 0.08;

    // 3. Traffic Spawning (65% Rate Fix)
    spawnTimer += dt;
    if (spawnTimer > 0.45) { 
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

    // 5. Particles
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx; p.y += p.vy;
        p.life -= dt * 2.5;
        if(p.life <= 0) particles.splice(i, 1);
    }

    // 6. Timers
    if (state.doubleTimer > 0) state.doubleTimer -= dt;
    
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
    let pts = 10;
    if (Date.now() - state.lastComboTime < 1500) state.combo++;
    else state.combo = 1;
    state.lastComboTime = Date.now();
    
    pts *= state.combo;
    if (state.doubleTimer > 0) pts *= 2;
    state.score += pts;
    
    // LIVE COIN SYSTEM
    if(typeof state.coinBuffer === 'undefined') state.coinBuffer = 0;
    state.coinBuffer += pts;
    while (state.coinBuffer >= 250) {
        state.coinBuffer -= 250;
        state.coins += 2;
        Audio.sfx('coin');
        saveData();
        document.getElementById('coin-hud').innerText = "COINS: " + state.coins;
    }

    document.getElementById('ui-score').innerText = state.score;
}

function crash(t) {
    if (state.inventory.shield) {
        state.inventory.shield = false;
        shakeScreen(10);
        Audio.sfx('crash');
        explode(t.x + t.w/2, t.y + t.h/2);
        t.y = height + 500; 
        return;
    }
    
    state.mode = 'OVER';
    state.paused = false;
    shakeScreen(25);
    Audio.sfx('crash');
    explode(player.visualX + player.w/2, player.y + player.h/2);
    
    // NO COIN CALCULATION HERE ANYMORE
    
    if (state.score > state.best) state.best = state.score;
    saveData();
    
    document.getElementById('go-score').innerText = state.score;
    document.getElementById('go-coins').innerText = state.coins;
    document.getElementById('coin-hud').innerText = "COINS: " + state.coins;
    
    showScreen('gameover-screen');
    document.getElementById('btn-pause').style.display = 'none';
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
    state.score = 0;
    state.runtime = 0;
    state.lane = 1;
    state.coinBuffer = 0;
    state.doubleTimer = state.inventory.double ? 30 : 0;
    if (state.inventory.turbo) state.speed = 40;
    
    traffic = [];
    particles = [];
    
    resize();
    player.visualX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    
    showScreen(null);
    document.getElementById('coin-hud').innerText = "COINS: " + state.coins;
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
            document.getElementById('coin-hud').innerText = "COINS: " + state.coins;
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
document.getElementById('coin-hud').innerText = "COINS: " + state.coins;
document.getElementById('btn-pause').style.display = 'none';
resize();
requestAnimationFrame(loop);