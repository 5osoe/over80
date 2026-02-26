importScripts('https://unpkg.com/ag-psd/dist/bundle.js');

// ---------------------------------------------------------
// FIX: تهيئة الـ Canvas للعمل داخل الـ Web Worker
// هذا الجزء يخبر المكتبة باستخدام OffscreenCanvas بدلاً من DOM Canvas
// ---------------------------------------------------------
agPsd.initializeCanvas((width, height) => {
    const canvas = new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    return canvas;
});
// ---------------------------------------------------------

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
        // إرسال الخطأ إلى الواجهة الرئيسية ليظهر للمستخدم
        self.postMessage({ type: 'error', data: err.message });
    }
};

async function handleParse(buffer) {
    // قراءة ملف الـ PSD
    // useImageData: true يضمن قراءة بيانات البكسل
    psd = agPsd.readPsd(buffer, {
        skipLayerChildren: false,
        skipThumbnail: true,
        useImageData: true 
    });

    const visibleLayers = [];
    
    // دالة لاستخراج الطبقات المرئية فقط (Raster Layers)
    function traverse(node) {
        if (node.children) {
            // إذا كان مجلداً (Group)
            // إذا المجلد مخفي، نتجاهل ما بداخله
            if (node.hidden) return; 
            node.children.forEach(traverse);
        } else {
            // إذا كانت طبقة عادية
            // الشروط: غير مخفية، وتحتوي على canvas (بيانات صور)، وليست طبقة تعديل
            if (!node.hidden && node.canvas) {
                visibleLayers.push(node);
            }
        }
    }

    if (psd.children) {
        psd.children.forEach(traverse);
    }

    // تجهيز البيانات لإرسالها للواجهة (UI)
    // نقوم بإنشاء صور مصغرة (Thumbnails) لتخفيف الضغط على الذاكرة
    const payload = [];

    for (let i = 0; i < visibleLayers.length; i++) {
        const layer = visibleLayers[i];
        
        // إضافة ID فريد للرجوع إليه لاحقاً
        layer._uniqId = i; 

        // إنشاء صورة مصغرة
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
    // تصغير الصورة للعرض في القائمة
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
    
    // تحويل الـ Blob إلى DataURL باستخدام FileReaderSync (متاح فقط في الـ Workers)
    const reader = new FileReaderSync();
    return reader.readAsDataURL(blob);
}

async function handleExport(ids, format) {
    if (!psd) throw new Error("PSD data lost. Please reload.");

    const exportFiles = [];
    const targetMime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpg' ? 'jpg' : 'png';

    // البحث عن الطبقات المطلوبة للتصدير
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
    
    if (psd.children) {
        psd.children.forEach(findLayers);
    }

    // معالجة التصدير
    for (const layer of layersToExport) {
        // الحفاظ على دقة الـ Canvas الأصلية وموقع الطبقة
        const finalCanvas = new OffscreenCanvas(psd.width, psd.height);
        const ctx = finalCanvas.getContext('2d');

        // رسم الطبقة في موقعها الصحيح (Left, Top)
        if (layer.canvas) {
            ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
        }

        // تحويل إلى ملف (Blob)
        // الجودة 1.0 (100%)
        const blob = await finalCanvas.convertToBlob({ 
            type: targetMime, 
            quality: 1.0 
        });

        // تنظيف اسم الملف
        const safeName = (layer.name || `Layer_${layer._uniqId}`).replace(/[^a-z0-9\-_]/gi, '_');
        
        exportFiles.push({
            name: `${safeName}.${ext}`,
            blob: blob
        });
    }

    self.postMessage({ type: 'exportData', data: { files: exportFiles } });
}