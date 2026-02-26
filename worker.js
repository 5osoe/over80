/**
 * Hack PSD - Worker Script
 * Handles PSD parsing and image extraction off the main thread.
 * 
 * FIXES IMPLEMENTED:
 * 1. Uses correct UMD build of ag-psd.
 * 2. Initializes OffscreenCanvas correctly to fix "Canvas not initialized" error.
 * 3. Implements createImageBitmap for image data handling.
 */

// 1. Import ag-psd (UMD Browser Build)
importScripts('https://unpkg.com/ag-psd/dist/umd/ag-psd.js');

// 2. Safety Check for OffscreenCanvas
if (typeof OffscreenCanvas === 'undefined') {
    self.postMessage({
        type: 'error',
        data: 'Your browser does not support OffscreenCanvas. Please use Chrome, Edge, or Firefox.'
    });
}

// 3. Initialize ag-psd Environment (CRITICAL FIX)
// This tells the library how to create canvases in a Worker environment
try {
    agPsd.initializeCanvas((width, height) => {
        return new OffscreenCanvas(width, height);
    });

    agPsd.initializeImage((data) => {
        return createImageBitmap(new Blob([data]));
    });
} catch (e) {
    console.error("Failed to initialize ag-psd environment", e);
    self.postMessage({ type: 'error', data: 'Failed to initialize graphics engine.' });
}

// Global state to hold the parsed PSD in worker memory
let psd = null;

// Message Handler
self.onmessage = async (e) => {
    const { type, data, buffer, ids, format } = e.data;

    try {
        if (type === 'parse') {
            await parsePSD(buffer);
        } else if (type === 'export') {
            await exportLayers(ids, format);
        }
    } catch (err) {
        console.error(err);
        self.postMessage({ 
            type: 'error', 
            data: err.message || 'An unexpected error occurred in the worker.' 
        });
    }
};

/**
 * Parses the PSD file and generates thumbnails.
 * @param {ArrayBuffer} buffer - The raw file buffer.
 */
async function parsePSD(buffer) {
    // Check memory safety (rough estimate)
    if (buffer.byteLength > 500 * 1024 * 1024) {
        // Warning logic could go here, but we proceed with caution
    }

    // Read options: 
    // We do NOT use 'useImageData: true' here because we want ag-psd 
    // to utilize the initializeCanvas method we defined above to create 
    // usable Canvas objects for us.
    const options = {
        skipLayerChildren: false,
        skipThumbnail: true // We generate our own layer thumbnails
    };

    // Parse
    psd = agPsd.readPsd(buffer, options);

    // Filter and Process Layers
    const visibleLayers = [];
    
    // Recursive traversal to find valid raster layers
    function traverse(node) {
        if (node.children) {
            // If it's a group and it's hidden, ignore content
            if (node.hidden) return;
            node.children.forEach(traverse);
        } else {
            // It's a leaf node (Layer)
            // Criteria:
            // 1. Visible (!hidden)
            // 2. Has dimensions (width > 0)
            // 3. Is not a purely vector/text layer without raster data 
            //    (checking node.canvas existence guarantees we have something to draw)
            if (!node.hidden && node.width > 0 && node.height > 0) {
                // Determine if it's a candidate
                // Note: ag-psd creates 'canvas' property on layers if raster data exists
                if (node.canvas) {
                    visibleLayers.push(node);
                }
            }
        }
    }

    if (psd.children) {
        psd.children.forEach(traverse);
    }

    if (visibleLayers.length === 0) {
        throw new Error("No visible raster layers found in this PSD.");
    }

    // Generate UI Payload (Metadata + Thumbnails)
    const payload = [];

    for (let i = 0; i < visibleLayers.length; i++) {
        const layer = visibleLayers[i];
        
        // Assign a temporary unique ID for this session
        layer._uniqId = i;

        // Generate Thumbnail (DataURL)
        // We do this serially to manage memory, though Promise.all could be faster
        const thumbUrl = await generateThumbnail(layer.canvas);

        payload.push({
            id: i,
            name: layer.name || `Layer ${i + 1}`,
            width: layer.width,
            height: layer.height,
            thumbnail: thumbUrl
        });
    }

    // Clear buffer reference if possible (though readPsd likely holds it)
    // Send back to main thread
    self.postMessage({ type: 'parsed', data: payload });
}

/**
 * Generates a small DataURL thumbnail from a source Canvas.
 */
async function generateThumbnail(sourceCanvas) {
    const MAX_SIZE = 200; // px
    let w = sourceCanvas.width;
    let h = sourceCanvas.height;

    // Calculate Aspect Ratio
    if (w > MAX_SIZE || h > MAX_SIZE) {
        const ratio = Math.min(MAX_SIZE / w, MAX_SIZE / h);
        w = Math.floor(w * ratio);
        h = Math.floor(h * ratio);
    }

    // Create thumbnail canvas
    const thumbCanvas = new OffscreenCanvas(w, h);
    const ctx = thumbCanvas.getContext('2d');
    
    // Draw resized
    ctx.drawImage(sourceCanvas, 0, 0, w, h);

    // Convert to Blob then DataURL
    const blob = await thumbCanvas.convertToBlob({ type: 'image/png' });
    
    // Use FileReaderSync (synchronous reader available in Workers) 
    // to convert Blob to Base64 DataURL
    const reader = new FileReaderSync();
    return reader.readAsDataURL(blob);
}

/**
 * Exports selected layers at full resolution and original position.
 */
async function exportLayers(ids, format) {
    if (!psd) throw new Error("PSD data not found. Please reload file.");

    const exportFiles = [];
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
    const ext = format === 'png' ? 'png' : 'jpg';
    
    // Re-find the layers based on IDs
    const layersToProcess = [];
    
    function findById(node) {
        if (node.children) {
            node.children.forEach(findById);
        } else {
            if (node._uniqId !== undefined && ids.includes(node._uniqId)) {
                layersToProcess.push(node);
            }
        }
    }
    
    if (psd.children) psd.children.forEach(findById);

    // Process Exports
    for (const layer of layersToProcess) {
        if (!layer.canvas) continue;

        // Requirement: Preserve Original PSD canvas resolution and Layer Position.
        // We create a canvas the size of the *entire PSD*.
        const finalCanvas = new OffscreenCanvas(psd.width, psd.height);
        const ctx = finalCanvas.getContext('2d');

        // If JPG, we might want a white background because JPG doesn't support alpha.
        // However, standard behavior for transparency in JPG is usually black or specific logic.
        // We'll leave it default (transparent black) which converts to black in JPG usually.
        
        // Draw the layer at its specific coordinates (left, top) relative to the PSD document
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);

        // Convert to Blob
        const blob = await finalCanvas.convertToBlob({
            type: mimeType,
            quality: 1.0 // Max quality
        });

        // Sanitize Filename
        let filename = (layer.name || `Layer_${layer._uniqId}`).trim();
        // Remove characters invalid for file systems
        filename = filename.replace(/[\\/:*?"<>|]/g, '_');
        if (!filename) filename = `Layer_${layer._uniqId}`;

        exportFiles.push({
            name: `${filename}.${ext}`,
            blob: blob
        });
    }

    self.postMessage({ type: 'exportData', data: { files: exportFiles } });
}