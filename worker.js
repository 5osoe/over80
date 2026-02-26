// استيراد المكتبة (إصدار المتصفح UMD)
importScripts('https://unpkg.com/ag-psd/dist/umd/ag-psd.js');

// 1. تحقق من دعم المتصفح
if (typeof OffscreenCanvas === 'undefined') {
    self.postMessage({ type: 'error', data: 'Browser not supported. Use Chrome/Edge/Firefox.' });
}

// 2. تهيئة الـ Canvas (مهم جداً للإصلاح)
try {
    agPsd.initializeCanvas((width, height) => {
        return new OffscreenCanvas(width, height);
    });
} catch (e) {
    self.postMessage({ type: 'error', data: 'Graphics initialization failed.' });
}

let psd = null;

self.onmessage = async (e) => {
    const { type, buffer, ids, format } = e.data;
    try {
        if (type === 'parse') await parse(buffer);
        else if (type === 'export') await exportLayers(ids, format);
    } catch (err) {
        self.postMessage({ type: 'error', data: err.message || 'Worker Error' });
    }
};

async function parse(buffer) {
    // قراءة الملف (بدون useImageData لتجنب التعارض)
    psd = agPsd.readPsd(buffer, {
        skipLayerChildren: false,
        skipThumbnail: true
    });

    const validLayers = [];

    // البحث عن الطبقات
    function scan(node) {
        if (node.children) {
            if (!node.hidden) node.children.forEach(scan);
        } else {
            // شروط الطبقة الصالحة: غير مخفية، ولها عرض وطول
            if (!node.hidden && node.width > 0 && node.height > 0) {
                validLayers.push(node);
            }
        }
    }
    if (psd.children) psd.children.forEach(scan);

    if (validLayers.length === 0) throw new Error("No visible layers found.");

    // تجهيز الصور المصغرة
    const payload = [];
    for (let i = 0; i < validLayers.length; i++) {
        const layer = validLayers[i];
        layer._uniqId = i; // حفظ ID داخلي

        let thumb = '';
        try {
            // محاولة رسم الطبقة
            if (layer.canvas) {
                thumb = await makeThumb(layer.canvas);
            } else {
                // صورة فارغة في حال الفشل
                thumb = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            }
        } catch(err) { console.warn('Thumb fail', i); }

        payload.push({
            id: i,
            name: layer.name || `Layer ${i}`,
            width: layer.width,
            height: layer.height,
            thumbnail: thumb
        });
    }

    self.postMessage({ type: 'parsed', data: payload });
}

async function makeThumb(source) {
    const MAX = 160;
    let w = source.width, h = source.height;
    if (w > MAX || h > MAX) {
        const r = Math.min(MAX/w, MAX/h);
        w *= r; h *= r;
    }
    const cvs = new OffscreenCanvas(w, h);
    cvs.getContext('2d').drawImage(source, 0, 0, w, h);
    const blob = await cvs.convertToBlob();
    return new FileReaderSync().readAsDataURL(blob);
}

async function exportLayers(ids, format) {
    if (!psd) throw new Error("Reload required.");
    
    const files = [];
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const ext = format === 'png' ? 'png' : 'jpg';

    // العثور على الطبقات المختارة
    const targets = [];
    function find(node) {
        if (node.children) node.children.forEach(find);
        else if (node._uniqId !== undefined && ids.includes(node._uniqId)) targets.push(node);
    }
    if (psd.children) psd.children.forEach(find);

    for (const layer of targets) {
        if (!layer.canvas) continue;

        // رسم بالحجم الكامل في الموقع الأصلي
        const cvs = new OffscreenCanvas(psd.width, psd.height);
        const ctx = cvs.getContext('2d');
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);

        const blob = await cvs.convertToBlob({ type: mime, quality: 1.0 });
        
        let name = (layer.name || `Layer_${layer._uniqId}`).trim().replace(/[\\/:*?"<>|]/g, '_');
        if(!name) name = `Layer_${layer._uniqId}`;
        
        files.push({ name: `${name}.${ext}`, blob });
    }

    self.postMessage({ type: 'exportData', data: { files } });
}