importScripts('https://unpkg.com/ag-psd/dist/bundle.js');

// 1. تهيئة الـ Canvas للعمل داخل الـ Worker
agPsd.initializeCanvas((width, height) => {
    const canvas = new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    return canvas;
});

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
        self.postMessage({ type: 'error', data: err.message || "Unknown Worker Error" });
    }
};

async function handleParse(buffer) {
    // 2. قراءة الملف مع إعدادات تضمن إنشاء الصور
    // قمنا بإزالة useImageData: true للسماح للمكتبة بإنشاء layer.canvas تلقائياً
    psd = agPsd.readPsd(buffer, {
        skipLayerChildren: false,
        skipThumbnail: true
    });

    const visibleLayers = [];
    
    // 3. دالة فحص الطبقات (أكثر مرونة الآن)
    function traverse(node) {
        if (node.children) {
            // هذا مجلد (Group)
            if (node.hidden) return; // تخطي المجلدات المخفية
            node.children.forEach(traverse);
        } else {
            // هذه طبقة (Layer)
            // الشروط:
            // 1. ليست مجلداً (!node.children)
            // 2. غير مخفية (!node.hidden)
            // 3. لها أبعاد حقيقية (ليست طبقة فارغة)
            if (!node.children && !node.hidden && node.width > 0 && node.height > 0) {
                visibleLayers.push(node);
            }
        }
    }

    if (psd.children) {
        psd.children.forEach(traverse);
    }

    // إذا لم يجد طبقات، جرب البحث حتى في المجلدات المخفية كحل أخير (اختياري، هنا نلتزم بالمرئي)
    if (visibleLayers.length === 0) {
        throw new Error("No visible layers found. Check if layers are hidden or empty.");
    }

    // 4. تجهيز البيانات للواجهة
    const payload = [];

    for (let i = 0; i < visibleLayers.length; i++) {
        const layer = visibleLayers[i];
        
        // منح معرف فريد
        layer._uniqId = i; 

        // محاولة استخراج الصورة المصغرة
        let thumbUrl = '';
        try {
            // إذا كان الـ Canvas موجوداً (وهو المتوقع الآن) نستخدمه
            // إذا لم يكن موجوداً، نحاول رسمه (Fallback)
            if (layer.canvas) {
                thumbUrl = await createThumbnail(layer.canvas);
            } else {
                // في حالة نادرة (مثل Smart Object أو Text)، قد لا يكون هناك canvas جاهز
                // نستخدم صورة فارغة أو نحاول الرسم يدوياً (هنا نضع صورة شفافة لتجنب الخطأ)
                thumbUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            }
        } catch (err) {
            console.warn(`Failed to create thumbnail for layer ${i}`, err);
        }

        payload.push({
            id: i,
            name: layer.name || `Layer ${i + 1}`,
            width: layer.width,
            height: layer.height,
            thumbnail: thumbUrl
        });
    }

    self.postMessage({ type: 'parsed', data: payload });
}

async function createThumbnail(canvasElement) {
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
    
    // رسم الصورة
    ctx.drawImage(canvasElement, 0, 0, w, h);

    const blob = await thumbCanvas.convertToBlob({ type: 'image/png' });
    const reader = new FileReaderSync();
    return reader.readAsDataURL(blob);
}

async function handleExport(ids, format) {
    if (!psd) throw new Error("PSD data lost. Please reload.");

    const exportFiles = [];
    const targetMime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpg' ? 'jpg' : 'png';

    // جمع الطبقات المختارة
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
    if (psd.children) psd.children.forEach(findLayers);

    for (const layer of layersToExport) {
        if (!layer.canvas) continue; // تخطي إذا لم يكن هناك بيانات صورة

        // إنشاء Canvas بحجم ملف الـ PSD الأصلي
        const finalCanvas = new OffscreenCanvas(psd.width, psd.height);
        const ctx = finalCanvas.getContext('2d');

        // رسم الطبقة في مكانها الصحيح
        ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);

        const blob = await finalCanvas.convertToBlob({ 
            type: targetMime, 
            quality: 1.0 
        });

        // تنظيف الاسم
        let safeName = (layer.name || `Layer_${layer._uniqId}`).trim();
        safeName = safeName.replace(/[\\/:*?"<>|]/g, '_'); // إزالة الرموز الممنوعة في الويندوز/الماك
        if (safeName === '') safeName = `Layer_${layer._uniqId}`;

        exportFiles.push({
            name: `${safeName}.${ext}`,
            blob: blob
        });
    }

    self.postMessage({ type: 'exportData', data: { files: exportFiles } });
}