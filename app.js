
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
    
    // Persistent Stats (Phase 4)
    score: parseInt(localStorage.getItem('rush80_score')) || 0,
    hearts: parseInt(localStorage.getItem('rush80_hearts')) || 5,
    nextBossScore: parseInt(localStorage.getItem('rush80_nextBoss')) || 10000,
    
    // Temporary / Dynamic
    coinBuffer: parseInt(localStorage.getItem('rush80_coinBuffer')) || 0,
    miniCounter: 0,
    bossActive: false,
    bossHP: 0,
    
    // Runtime
    speed: 0,
    lane: 1, // 0 to 3
    doubleTimer: 0,
    runtime: 0,
    paused: false
};

let player = { visualX: 0, y: 0, w: 0, h: 0, tilt: 0 };
let traffic = [];
let particles = [];

// PHASE 2 GLOBALS
let miniEnemies = [];
let playerBullets = [];

// PHASE 3 GLOBALS
let boss = null;
let bossBullets = [];
let bossShootTimer = 0;

let roadOffset = 0;
let lastTime = 0;
let spawnTimer = 0;

/** 
 * --- UI FUNCTIONS --- 
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
    
    // 1. Acceleration
    let targetSpeed = CONFIG.maxSpeed;
    const accel = state.inventory.turbo ? 1.2 : 0.8;
    
    // PHASE 3: Slow down for boss
    if(state.bossActive) targetSpeed = CONFIG.maxSpeed * 0.6;
    
    state.speed += (targetSpeed - state.speed) * accel * dt;
    
    // 2. Player Movement
    const targetX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    const lerpSpeed = 12;
    player.visualX += (targetX - player.visualX) * lerpSpeed * dt;
    player.tilt = (targetX - player.visualX) * 0.08;

    // 3. Traffic Spawning (Prevent during Boss)
    spawnTimer += dt;
    if (!state.bossActive && spawnTimer > 0.45) { 
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
            
            // PHASE 2: COUNT PASSED CARS (Only if boss not active)
            if(!state.bossActive){
                state.miniCounter++;

                if(state.miniCounter >= 15){
                    state.miniCounter = 0;
                    if(miniEnemies.length < 2){
                        spawnMiniEnemy();
                    }
                }
            }
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

    // PHASE 2: UPDATE MINI ENEMIES
    for(let i = miniEnemies.length - 1; i >= 0; i--){
        const m = miniEnemies[i];

        m.y += 180 * dt;

        // Bullet collision (Player bullets hitting mini enemies)
        for(let j = playerBullets.length - 1; j >= 0; j--){
            const b = playerBullets[j];

            if(b.x < m.x + m.w &&
               b.x + b.w > m.x &&
               b.y < m.y + m.h &&
               b.y + b.h > m.y){

                m.hp--;
                playerBullets.splice(j,1);

                if(m.hp <= 0){
                    state.score += 20;
                    // Note: No saveData() on mini enemy kill to avoid spamming writes
                    document.getElementById('ui-score').innerText = state.score;
                    miniEnemies.splice(i,1);
                }

                break;
            }
        }

        // If passes player
        if(m.y > player.y + player.h){
            state.score -= 20;
            document.getElementById('ui-score').innerText = state.score;
            miniEnemies.splice(i,1);
        }
    }

    // PHASE 3: BOSS LOGIC
    if(state.bossActive && boss){
        // Boss Movement
        boss.x += boss.dir * boss.speed * dt;
        if(boss.x <= 0 || boss.x + boss.w >= width){
            boss.dir *= -1;
        }
        
        // Boss Shooting
        bossShootTimer += dt;
        if(bossShootTimer >= 1.2){
            bossShootTimer = 0;
            bossBullets.push({
                x: boss.x + boss.w/2 - 5,
                y: boss.y + boss.h,
                w: 10,
                h: 16,
                speed: 300
            });
        }
    }
    
    // PHASE 3: BOSS BULLETS
    for(let i = bossBullets.length - 1; i >= 0; i--){
        bossBullets[i].y += bossBullets[i].speed * dt;

        // Collision with player
        if(bossBullets[i].x < player.visualX + player.w &&
           bossBullets[i].x + bossBullets[i].w > player.visualX &&
           bossBullets[i].y < player.y + player.h &&
           bossBullets[i].y + bossBullets[i].h > player.y){

            state.hearts--;
            updateHeartsUI();
            shakeScreen(10);
            Audio.sfx('crash');
            
            // Phase 4: Save on heart loss
            saveData();

            bossBullets.splice(i,1);

            if(state.hearts <= 0){
                gameOver();
            }

            continue;
        }

        if(bossBullets[i].y > height){
            bossBullets.splice(i,1);
        }
    }

    // PHASE 2 & 3: UPDATE PLAYER BULLETS
    for(let i = playerBullets.length - 1; i >= 0; i--){
        let b = playerBullets[i];
        b.y -= b.speed * dt;

        // Check Boss Collision (Phase 3)
        if(state.bossActive && boss){
            if(b.x < boss.x + boss.w &&
               b.x + b.w > boss.x &&
               b.y < boss.y + boss.h &&
               b.y + b.h > boss.y){

                state.bossHP--;
                playerBullets.splice(i,1);

                if(state.bossHP <= 0){
                    endBossFight();
                }
                continue; // Bullet removed, next iteration
            }
        }

        if(b.y < -20){
            playerBullets.splice(i,1);
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

// PHASE 2: SPAWN LOGIC
function spawnMiniEnemy(){
    const lane = Math.floor(Math.random() * CONFIG.laneCount);
    const x = (lane * laneWidth) + (laneWidth/2) - (player.w/2);

    miniEnemies.push({
        lane: lane,
        x: x,
        y: -200,
        w: player.w,
        h: player.h,
        hp: 3,
        type: "mini"
    });
}

function spawnPlayerBullet(){
    playerBullets.push({
        x: player.visualX + player.w/2 - 4,
        y: player.y,
        w: 8,
        h: 14,
        speed: 500
    });
}

// PHASE 3: BOSS LOGIC
function startBossFight(){
    state.bossActive = true;
    state.bossHP = 25;

    boss = {
        x: width/2 - 60,
        y: 80,
        w: 120,
        h: 60,
        dir: 1,
        speed: 120
    };

    // Clear traffic and mini enemies
    traffic.length = 0;
    miniEnemies.length = 0;

    // Reduce speed is handled in update()
}

function endBossFight(){
    state.bossActive = false;
    state.score += 150;
    document.getElementById('ui-score').innerText = state.score;

    state.nextBossScore += 10000;
    
    // Phase 4: Save on boss reward
    saveData();

    boss = null;
    bossBullets.length = 0;

    state.speed = CONFIG.maxSpeed;
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
    
    // Phase 4: Save on score add
    saveData();

    state.coinBuffer += pts;
    while (state.coinBuffer >= 100) { 
        state.coinBuffer -= 100;
        state.coins += 5;
        Audio.sfx('coin'); 
        updateCoinHUD();
        // Save handled above
    }
    
    // PHASE 3 TRIGGER
    if(!state.bossActive && state.score >= state.nextBossScore){
        startBossFight();
    }

    document.getElementById('ui-score').innerText = state.score;
}

// PHASE 5: CLEAN GAME OVER
function gameOver(){
    // Capture score for display
    const finalScore = state.score;
    if (finalScore > state.best) state.best = finalScore;

    // Deduct 25 coins (minimum 0)
    state.coins = Math.max(0, state.coins - 25);

    // Reset progression (Persistent Reset)
    state.score = 0;
    state.hearts = 5;
    state.nextBossScore = 10000;

    // Clear dynamic systems
    miniEnemies.length = 0;
    playerBullets.length = 0;
    bossBullets.length = 0;
    boss = null;
    state.bossActive = false;
    traffic.length = 0;

    // Save the reset state
    saveData();

    // UI Updates
    document.getElementById('ui-score').innerText = 0;
    updateHeartsUI();
    updateCoinHUD();

    // Screen Logic
    state.mode = 'OVER';
    state.paused = false;

    document.getElementById('go-score').innerText = finalScore;
    document.getElementById('go-coins').innerText = state.coins;

    showScreen('gameover-screen');
    document.getElementById('btn-pause').style.display = 'none';
}

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
    
    // Phase 4: Save on heart loss
    saveData();

    // Remove the traffic car
    t.y = height + 500;

    // If no hearts left → Game Over
    if(state.hearts <= 0){
        gameOver();
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
    }

    traffic.forEach(t => drawCar(t.x, t.y, t.w, t.h, cCar, false));

    // PHASE 2: DRAW BULLETS
    playerBullets.forEach(b => {
        ctx.fillStyle = '#cc0000';
        ctx.fillRect(b.x, b.y, b.w, b.h);
    });

    // PHASE 2: DRAW MINI ENEMIES
    miniEnemies.forEach(m=>{
        ctx.fillStyle = '#cc0000';
        ctx.fillRect(m.x, m.y, m.w, m.h);
    });

    // PHASE 3: DRAW BOSS
    if(state.bossActive && boss){
        ctx.fillStyle = "#990000";
        ctx.fillRect(boss.x, boss.y, boss.w, boss.h);
    }

    // PHASE 3: DRAW BOSS BULLETS
    bossBullets.forEach(b=>{
        ctx.fillStyle = "#ff4444";
        ctx.fillRect(b.x, b.y, b.w, b.h);
    });

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

// PHASE 2: INPUT MODIFICATION
document.getElementById('touch-area').addEventListener('touchstart', (e) => {
    e.preventDefault();
    if(e.target.id === 'btn-pause') return;
    if(state.mode !== 'PLAY' || state.paused) return;
    
    const touch = e.touches[0];
    const touchX = touch.clientX;
    const touchY = touch.clientY;
    
    // Check if tap intersects with any mini enemy (Phase 2)
    let shot = false;
    for(let m of miniEnemies){
        if(touchX > m.x && touchX < m.x + m.w && touchY > m.y && touchY < m.y + m.h){
            if(state.coins > 0){
                spawnPlayerBullet();
                state.coins -= 1;
                updateCoinHUD();
                shot = true;
                break; // Shoot one at a time per tap
            }
        }
    }
    
    // PHASE 3: Shoot at Boss on tap
    if(!shot && state.bossActive && boss){
         if(touchX > boss.x && touchX < boss.x + boss.w && touchY > boss.y && touchY < boss.y + boss.h){
            if(state.coins > 0){
                spawnPlayerBullet();
                state.coins -= 1;
                updateCoinHUD();
                shot = true;
            }
         }
    }

    // Normal movement logic always active
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
    state.runtime = 0;
    state.lane = 1;
    
    // Phase 4: Do NOT reset hearts/score here to allow resuming.
    state.miniCounter = 0; 
    
    // Reset Boss Logic (if we exited mid-boss, we restart outside of boss)
    state.bossActive = false;
    boss = null;
    bossBullets = [];
    
    // SAVE ON RESET (Ensures clean state)
    saveData();

    state.doubleTimer = state.inventory.double ? 30 : 0;
    if (state.inventory.turbo) state.speed = 40;
    
    traffic = [];
    particles = [];
    miniEnemies = []; 
    playerBullets = []; 
    
    resize();
    player.visualX = (state.lane * laneWidth) + (laneWidth/2) - (player.w/2);
    
    showScreen(null);
    updateCoinHUD();
    updateHeartsUI();
    
    // Update Score UI from loaded state
    document.getElementById('ui-score').innerText = state.score;
    
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
        saveData(); // Save on pause
    } else {
        Audio.resume();
        overlay.classList.remove('visible');
    }
};

// PHASE 4: UPDATE SAVE SYSTEM
function saveData() {
    localStorage.setItem('rush80_coins', state.coins);
    localStorage.setItem('rush80_best', state.best);
    localStorage.setItem('rush80_inv', JSON.stringify(state.inventory));
    
    // New Persistent Stats
    localStorage.setItem('rush80_score', state.score);
    localStorage.setItem('rush80_hearts', state.hearts);
    localStorage.setItem('rush80_nextBoss', state.nextBossScore);
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

// AUDIO SAFETY & AUTO SAVE
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        if(state.mode === 'PLAY') state.paused = true;
        if(Audio && Audio.ctx) Audio.ctx.suspend();
        saveData(); // Save on exit
    } else {
        if(Audio && Audio.ctx && !state.paused) Audio.ctx.resume();
    }
});

window.addEventListener("blur", () => {
    if(state.mode === 'PLAY') state.paused = true;
    if (Audio && Audio.ctx) Audio.ctx.suspend();
    saveData();
});

window.addEventListener("beforeunload", () => {
    saveData();
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