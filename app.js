// App State
const state = {
    worker: null,
    layers: [],
    selectedIds: new Set(),
    exportFormat: 'jpg'
};

// DOM Elements
const els = {
    dropZone: document.getElementById('upload-area'),
    fileInput: document.getElementById('file-input'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    spinner: document.getElementById('loading-spinner'),
    statusText: document.getElementById('status-text'),
    layersGrid: document.getElementById('layers-grid'),
    controls: document.getElementById('controls-section'),
    layerCount: document.getElementById('layer-count'),
    selectAllBtn: document.getElementById('select-all-btn'),
    exportBtn: document.getElementById('export-btn'),
    formatToggle: document.getElementById('format-toggle')
};

// Initialize Worker
function initWorker() {
    if (state.worker) state.worker.terminate(); // Reset if exists

    if (window.Worker) {
        state.worker = new Worker('worker.js');
        
        state.worker.onmessage = (e) => {
            const { type, data } = e.data;
            if (type === 'parsed') renderLayers(data);
            else if (type === 'error') handleError(data);
            else if (type === 'exportData') createZip(data);
        };
        
        state.worker.onerror = (e) => handleError("Worker crashed. See console.");
    } else {
        handleError("Browser doesn't support Web Workers.");
    }
}

// --- Events ---
els.dropZone.onclick = () => els.fileInput.click();
els.dropZone.ondragover = (e) => { e.preventDefault(); els.dropZone.classList.add('drag-over'); };
els.dropZone.ondragleave = () => els.dropZone.classList.remove('drag-over');
els.dropZone.ondrop = (e) => { e.preventDefault(); els.dropZone.classList.remove('drag-over'); handleFile(e.dataTransfer.files[0]); };
els.fileInput.onchange = (e) => handleFile(e.target.files[0]);

els.selectAllBtn.onclick = toggleAll;
els.exportBtn.onclick = startExport;
els.formatToggle.onchange = (e) => state.exportFormat = e.target.checked ? 'png' : 'jpg';

// --- Logic ---
function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.psd')) return handleError("Please upload a .PSD file");

    initWorker(); // Start fresh
    resetUI();
    els.progressContainer.classList.remove('hidden');
    
    const reader = new FileReader();
    reader.onprogress = (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            els.progressFill.style.width = `${pct}%`;
            els.progressText.innerText = `${pct}%`;
        }
    };
    reader.onload = (e) => {
        els.statusText.innerText = "Parsing PSD Layers... (Please Wait)";
        els.spinner.classList.remove('hidden');
        els.progressContainer.classList.add('hidden');
        state.worker.postMessage({ type: 'parse', buffer: e.target.result }, [e.target.result]);
    };
    reader.onerror = () => handleError("Failed to read file");
    reader.readAsArrayBuffer(file);
}

function renderLayers(layers) {
    els.spinner.classList.add('hidden');
    els.statusText.innerText = "";
    state.layers = layers;
    
    if (layers.length === 0) return handleError("No visible raster layers found.");

    els.controls.classList.remove('hidden');
    els.layerCount.innerText = `${layers.length} Layers Found`;
    els.layersGrid.innerHTML = '';

    layers.forEach(layer => {
        const div = document.createElement('div');
        div.className = 'layer-card';
        div.dataset.id = layer.id;
        div.onclick = (e) => {
            if (e.target.tagName !== 'INPUT') {
                const cb = div.querySelector('input');
                cb.checked = !cb.checked;
                toggleLayer(layer.id, cb.checked);
            }
        };
        div.innerHTML = `
            <div class="card-preview"><img src="${layer.thumbnail}" loading="lazy"></div>
            <div class="card-info">
                <div><div class="layer-name" title="${layer.name}">${layer.name}</div><span class="layer-dims">${layer.width}x${layer.height}</span></div>
                <div class="checkbox-wrapper"><input type="checkbox"><span class="custom-check"></span></div>
            </div>
        `;
        div.querySelector('input').onchange = (e) => toggleLayer(layer.id, e.target.checked);
        els.layersGrid.appendChild(div);
    });
}

function toggleLayer(id, isSelected) {
    const card = document.querySelector(`.layer-card[data-id="${id}"]`);
    if (isSelected) {
        state.selectedIds.add(id);
        if(card) card.classList.add('selected');
    } else {
        state.selectedIds.delete(id);
        if(card) card.classList.remove('selected');
    }
    updateExportBtn();
}

function toggleAll() {
    const all = state.selectedIds.size === state.layers.length;
    document.querySelectorAll('.layer-card input').forEach(cb => {
        cb.checked = !all;
        const id = parseInt(cb.closest('.layer-card').dataset.id);
        toggleLayer(id, !all);
    });
    els.selectAllBtn.innerText = all ? "Select All" : "Deselect All";
}

function updateExportBtn() {
    const count = state.selectedIds.size;
    els.exportBtn.innerText = count ? `Download Selected (${count})` : "Download Selected";
    els.exportBtn.disabled = !count;
    els.exportBtn.style.opacity = count ? '1' : '0.5';
}

function startExport() {
    if (!state.selectedIds.size) return;
    els.exportBtn.innerText = "Processing...";
    els.exportBtn.disabled = true;
    state.worker.postMessage({
        type: 'export',
        ids: Array.from(state.selectedIds),
        format: state.exportFormat
    });
}

async function createZip({ files }) {
    try {
        const zip = new JSZip();
        files.forEach(f => zip.file(f.name, f.blob));
        const content = await zip.generateAsync({ type: "blob" });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = `HackPSD_Export_${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        els.exportBtn.innerText = "Download Success!";
        setTimeout(() => updateExportBtn(), 2000);
    } catch (e) {
        handleError("Failed to create ZIP file");
    }
}

function resetUI() {
    els.layersGrid.innerHTML = '';
    els.controls.classList.add('hidden');
    els.statusText.innerText = '';
    state.selectedIds.clear();
    updateExportBtn();
}

function handleError(msg) {
    state.isProcessing = false;
    els.spinner.classList.add('hidden');
    els.progressContainer.classList.add('hidden');
    els.statusText.innerText = `Error: ${msg}`;
    els.statusText.style.color = '#ff4444';
}