importScripts('https://unpkg.com/ag-psd/dist/bundle.js');

let psd = null;

self.onmessage = async (e) => {
    const { type } = e.data;

    try {
        if (type === 'parse') {
            await handleParse(e.data.buffer);
        } else if (type === 'export') {
            await handleExport(e.data.ids, e.data.format);
        }
    } catch (err) {
        self.postMessage({ type: 'error', data: err.message });
    }
};

async function handleParse(buffer) {
    // Parse the PSD
    // We need 'canvas' to extract images. 
    // For large files, this is memory intensive, but ag-psd is reasonably efficient.
    psd = agPsd.readPsd(buffer, {
        skipLayerChildren: false,
        skipThumbnail: true
    });

    const visibleLayers = [];
    
    // Recursive traversal to find visible raster layers
    function traverse(node) {
        if (node.children) {
            // It's a group
            // If group is hidden, children are hidden
            if (node.hidden) return; 
            node.children.forEach(traverse);
        } else {
            // It's a layer
            // Criteria: Visible, has canvas (raster data), not adjustment layer
            if (!node.hidden && node.canvas) {
                visibleLayers.push(node);
            }
        }
    }

    if (psd.children) {
        psd.children.forEach(traverse);
    }

    // Process thumbnails for UI
    // We don't want to send huge bitmaps to the main thread yet.
    // We create small thumbnails here.
    const payload = [];

    for (let i = 0; i < visibleLayers.length; i++) {
        const layer = visibleLayers[i];
        
        // Add a unique ID for referencing later
        layer._uniqId = i; 

        // Create Thumbnail
        const thumbUrl = await createThumbnail(layer.canvas);

        payload.push({
            id: i,
            name: layer.name || `Layer ${i}`,
            width: layer.width,
            height: layer.height,
            thumbnail: thumbUrl
        });
    }

    self.postMessage({ type: 'parsed', data: payload });
}

async function createThumbnail(canvasElement) {
    // Resize for thumbnail to save UI memory
    // ag-psd returns an HTMLCanvasElement (or OffscreenCanvas in worker)
    // We can draw it to a smaller canvas
    const maxDim = 150;
    let w = canvasElement.width;
    let h = canvasElement.height;
    
    if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w *= ratio;
        h *= ratio;
    }

    const thumbCanvas = new OffscreenCanvas(w, h);
    const ctx = thumbCanvas.getContext('2d');
    ctx.drawImage(canvasElement, 0, 0, w, h);

    const blob = await thumbCanvas.convertToBlob({ type: 'image/png' });
    
    // Convert blob to DataURL for easy passing to main thread (FileReader)
    // Or just use FileReaderSync
    const reader = new FileReaderSync();
    return reader.readAsDataURL(blob);
}

async function handleExport(ids, format) {
    if (!psd) throw new Error("PSD data lost. Please reload.");

    const exportFiles = [];
    const targetMime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpg' ? 'jpg' : 'png';

    // Helper to find layer by ID
    const layersToExport = [];
    
    function findLayers(node) {
        if (node.children) {
            node.children.forEach(findLayers);
        } else {
            if (node._uniqId !== undefined && ids.includes(node._uniqId)) {
                layersToExport.push(node);
            }
        }
    }
    psd.children.forEach(findLayers);

    // Process export
    for (const layer of layersToExport) {
        // Requirement: Preserve Original PSD canvas resolution and Layer Position
        // Create canvas size of PSD
        const finalCanvas = new OffscreenCanvas(psd.width, psd.height);
        const ctx = finalCanvas.getContext('2d');

        // JPGs don't support transparency, so fill black/white if needed?
        // Usually 100% JPG on transparent canvas turns black. 
        // Let's leave it transparent for PNG, default black for JPG.
        
        // Draw layer at its specific coordinates
        ctx.drawImage(layer.canvas, layer.left, layer.top);

        // Convert to Blob
        // Quality 1.0 for JPG
        const blob = await finalCanvas.convertToBlob({ 
            type: targetMime, 
            quality: 1.0 
        });

        // Sanitize filename
        const safeName = (layer.name || `Layer_${layer._uniqId}`).replace(/[^a-z0-9]/gi, '_');
        
        exportFiles.push({
            name: `${safeName}.${ext}`,
            blob: blob
        });
    }

    self.postMessage({ type: 'exportData', data: { files: exportFiles } });
}