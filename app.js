// App State
const state = {
    worker: null,
    layers: [], // Stores metadata and thumb URLs
    isProcessing: false,
    selectedIds: new Set(),
    exportFormat: 'jpg'
};

// DOM Elements
const dropZone = document.getElementById('upload-area');
const fileInput = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const spinner = document.getElementById('loading-spinner');
const statusText = document.getElementById('status-text');
const layersGrid = document.getElementById('layers-grid');
const controlsSection = document.getElementById('controls-section');
const layerCountLabel = document.getElementById('layer-count');
const selectAllBtn = document.getElementById('select-all-btn');
const exportBtn = document.getElementById('export-btn');
const formatToggle = document.getElementById('format-toggle');

// Initialize Worker
function initWorker() {
    if (window.Worker) {
        state.worker = new Worker('worker.js');
        
        state.worker.onmessage = (e) => {
            const { type, data } = e.data;
            
            if (type === 'parsed') {
                handleParsedLayers(data);
            } else if (type === 'error') {
                showError(data);
            } else if (type === 'exportData') {
                finalizeExport(data);
            }
        };
    } else {
        showError("Web Workers are not supported in this browser.");
    }
}

initWorker();

// --- Event Listeners ---

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (files.length) processFile(files[0]);
});

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) processFile(e.target.files[0]);
});

// Controls
selectAllBtn.addEventListener('click', toggleSelectAll);
exportBtn.addEventListener('click', triggerExport);
formatToggle.addEventListener('change', (e) => {
    state.exportFormat = e.target.checked ? 'png' : 'jpg';
});

// --- Core Logic ---

function processFile(file) {
    if (state.isProcessing) return;
    
    // Validations
    if (!file.name.toLowerCase().endsWith('.psd')) {
        showError("Please upload a valid .PSD file.");
        return;
    }

    if (file.size > 300 * 1024 * 1024) {
        const confirmLarge = confirm(`This file is ${formatBytes(file.size)}. Large files (>300MB) may take a while or require significant memory. Continue?`);
        if (!confirmLarge) return;
    }

    // UI Reset
    resetUI();
    state.isProcessing = true;
    progressContainer.classList.remove('hidden');
    
    // Read File
    const reader = new FileReader();
    
    reader.onprogress = (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressFill.style.width = `${percent}%`;
            progressText.innerText = `${percent}%`;
            statusText.innerText = "Reading file into memory...";
        }
    };

    reader.onload = (e) => {
        statusText.innerText = "Parsing PSD structure... (This may take a moment)";
        spinner.classList.remove('hidden');
        progressContainer.classList.add('hidden');
        
        // Send ArrayBuffer to Worker
        state.worker.postMessage({
            type: 'parse',
            buffer: e.target.result
        }, [e.target.result]); // Transferable
    };

    reader.onerror = () => showError("Error reading file.");
    
    reader.readAsArrayBuffer(file);
}

function handleParsedLayers(layers) {
    spinner.classList.add('hidden');
    statusText.innerText = "";
    state.isProcessing = false;
    state.layers = layers;

    if (layers.length === 0) {
        showError("No visible raster layers found in this PSD.");
        return;
    }

    // Update UI
    controlsSection.classList.remove('hidden');
    layerCountLabel.innerText = `${layers.length} Layers Found`;
    
    // Render Grid
    layersGrid.innerHTML = '';
    layers.forEach((layer, index) => {
        const card = createLayerCard(layer, index);
        layersGrid.appendChild(card);
    });

    // Auto select all initially? No, let user choose.
}

function createLayerCard(layer, index) {
    const div = document.createElement('div');
    div.className = 'layer-card';
    div.dataset.id = layer.id;
    div.onclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
            const checkbox = div.querySelector('input');
            checkbox.checked = !checkbox.checked;
            toggleLayerSelection(layer.id, checkbox.checked);
        }
    };

    // Use the thumbnail generated by worker
    const imgUrl = layer.thumbnail;

    div.innerHTML = `
        <div class="card-preview">
            <img src="${imgUrl}" alt="${layer.name}">
        </div>
        <div class="card-info">
            <div>
                <div class="layer-name" title="${layer.name}">${layer.name}</div>
                <span class="layer-dims">${layer.width}x${layer.height}px</span>
            </div>
            <div class="checkbox-wrapper">
                <input type="checkbox" onchange="toggleLayerSelection(${layer.id}, this.checked)">
                <span class="custom-check"></span>
            </div>
        </div>
    `;
    return div;
}

// --- Selection Logic ---

window.toggleLayerSelection = (id, isSelected) => {
    if (isSelected) state.selectedIds.add(id);
    else state.selectedIds.delete(id);

    // Visual update
    const card = document.querySelector(`.layer-card[dataset-id="${id}"]`);
    if(card) {
        if(isSelected) card.classList.add('selected');
        else card.classList.remove('selected');
    }
    
    updateExportButton();
};

function toggleSelectAll() {
    const allSelected = state.selectedIds.size === state.layers.length;
    const checkboxes = document.querySelectorAll('.layer-card input');
    
    checkboxes.forEach(cb => {
        cb.checked = !allSelected;
        // Trigger visual update logic manually since setting checked doesn't fire event
        const card = cb.closest('.layer-card');
        const id = parseInt(card.dataset.id);
        
        if (!allSelected) {
            state.selectedIds.add(id);
            card.classList.add('selected');
        } else {
            state.selectedIds.delete(id);
            card.classList.remove('selected');
        }
    });

    selectAllBtn.innerText = allSelected ? "Select All" : "Deselect All";
    updateExportButton();
}

function updateExportButton() {
    const count = state.selectedIds.size;
    exportBtn.innerText = count > 0 ? `Download Selected (${count})` : `Download Selected`;
    exportBtn.disabled = count === 0;
    exportBtn.style.opacity = count === 0 ? '0.5' : '1';
}

// --- Export Logic ---

function triggerExport() {
    if (state.selectedIds.size === 0) return;

    exportBtn.innerText = "Processing...";
    exportBtn.disabled = true;

    // Request full resolution images from worker
    state.worker.postMessage({
        type: 'export',
        ids: Array.from(state.selectedIds),
        format: state.exportFormat
    });
}

async function finalizeExport({ files }) {
    try {
        const zip = new JSZip();

        files.forEach(f => {
            // f.blob is the image blob
            zip.file(f.name, f.blob);
        });

        // Generate Zip
        const content = await zip.generateAsync({ type: "blob" });
        
        // Trigger Download
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `hack-psd-export-${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Reset UI Button
        exportBtn.innerText = "Download Success!";
        setTimeout(() => updateExportButton(), 2000);

    } catch (err) {
        console.error(err);
        showError("Failed to generate ZIP file.");
        updateExportButton();
    }
}

// --- Utilities ---

function resetUI() {
    layersGrid.innerHTML = '';
    controlsSection.classList.add('hidden');
    statusText.innerText = '';
    state.selectedIds.clear();
    state.layers = [];
    updateExportButton();
}

function showError(msg) {
    statusText.innerText = `Error: ${msg}`;
    statusText.style.color = 'var(--accent)';
    spinner.classList.add('hidden');
    progressContainer.classList.add('hidden');
    state.isProcessing = false;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}