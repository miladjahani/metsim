let chart = null; // متغیر برای نگهداری نمونه نمودار

// این تابع زمانی اجرا می‌شود که OpenCV.js آماده استفاده باشد
function onOpenCvReady() {
    console.log('OpenCV.js is ready.');
    document.getElementById('analyzeButton').disabled = false;
    document.getElementById('loading').style.display = 'none';
}

// المان‌های DOM
const imageUpload = document.getElementById('imageUpload');
const analyzeButton = document.getElementById('analyzeButton');
const imageCanvas = document.getElementById('imageCanvas');
const resultChart = document.getElementById('resultChart');
const loadingDiv = document.getElementById('loading');
const errorContainer = document.getElementById('errorContainer');
const errorMessage = document.getElementById('errorMessage');
const ctx = imageCanvas.getContext('2d');

// غیرفعال کردن دکمه تحلیل و نمایش لودینگ تا زمان بارگذاری کامل OpenCV
analyzeButton.disabled = true;
loadingDiv.style.display = 'flex';

// تابع برای نمایش خطا
function showError(message) {
    errorMessage.textContent = message;
    errorContainer.classList.remove('hidden');
}

// تابع برای پنهان کردن خطا
function clearError() {
    errorContainer.classList.add('hidden');
}

// رویداد آپلود تصویر
imageUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    clearError(); // پاک کردن خطا هنگام آپلود تصویر جدید

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            imageCanvas.width = img.width;
            imageCanvas.height = img.height;
            ctx.drawImage(img, 0, 0);
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});

// رویداد کلیک روی دکمه تحلیل
analyzeButton.addEventListener('click', () => {
    if (!imageUpload.files[0]) {
        showError('لطفاً ابتدا یک تصویر انتخاب کنید.');
        return;
    }

    clearError();
    loadingDiv.style.display = 'flex';

    setTimeout(() => {
        try {
            analyzeImage();
        } catch (error) {
            console.error('خطا در هنگام تحلیل تصویر:', error);
            showError(`یک خطای غیرمنتظره رخ داد: ${error.message}. لطفاً کنسول را برای جزئیات بیشتر بررسی کنید.`);
        } finally {
            loadingDiv.style.display = 'none';
        }
    }, 50);
});

// تابع اصلی تحلیل تصویر
function analyzeImage() {
    console.log('شروع تحلیل تصویر...');

    let src;
    try {
        src = cv.imread(imageCanvas);
    } catch (err) {
        console.error("خطای OpenCV در خواندن تصویر از canvas:", err);
        throw new Error("امکان خواندن تصویر از canvas وجود ندارد. مطمئن شوید تصویر به درستی بارگذاری شده است.");
    }

    let gray = new cv.Mat();
    let blurred = new cv.Mat();
    let thresh = new cv.Mat();
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    let resultImage = src.clone();

    try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
        cv.threshold(blurred, thresh, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        const sizes = [];
        const minContourArea = 100; // فیلتر کردن نویزهای کوچک بر اساس مساحت

        for (let i = 0; i < contours.size(); ++i) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);

            if (area > minContourArea) {
                const equivalentDiameter = Math.sqrt(4 * area / Math.PI);
                sizes.push(equivalentDiameter);

                const rect = cv.boundingRect(cnt);
                let color = new cv.Scalar(0, 255, 0, 255);
                cv.rectangle(resultImage, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), color, 2);
            }
            cnt.delete();
        }

        cv.imshow(imageCanvas, resultImage);
        console.log(`تعداد ${sizes.length} سنگ پیدا شد.`);

        if (sizes.length > 0) {
            displayChart(sizes);
        } else {
            showError('هیچ سنگی برای تحلیل پیدا نشد. لطفاً از یک تصویر با کنتراست بهتر یا با سنگ‌های بزرگتر استفاده کنید.');
        }

    } finally {
        // پاک کردن حافظه تخصیص داده شده
        if (src) src.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (thresh) thresh.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
        if (resultImage) resultImage.delete();
    }
}

// تابع برای نمایش نمودار
function displayChart(sizes) {
    const minSize = Math.floor(Math.min(...sizes));
    const maxSize = Math.ceil(Math.max(...sizes));
    const numBins = 10;
    const binSize = (maxSize - minSize) / numBins;

    if (binSize <= 0) {
        // اگر همه سنگ‌ها یک اندازه باشند، یک بازه تکی ایجاد کن
        const singleBinLabel = `${(minSize - 1).toFixed(1)} - ${(maxSize + 1).toFixed(1)} mm`;
        const bins = [sizes.length];
        const labels = [singleBinLabel];
        drawChart(labels, bins);
        return;
    }

    const bins = Array(numBins).fill(0);
    const labels = [];

    for (let i = 0; i < numBins; i++) {
        const lowerBound = minSize + i * binSize;
        const upperBound = lowerBound + binSize;
        labels.push(`${lowerBound.toFixed(1)} - ${upperBound.toFixed(1)} mm`);
    }

    sizes.forEach(size => {
        let binIndex = Math.floor((size - minSize) / binSize);
        if (binIndex >= numBins) binIndex = numBins - 1; // برای بزرگترین مقدار
        if (binIndex < 0) binIndex = 0; // اطمینان از عدم وجود اندیس منفی
        bins[binIndex]++;
    });

    drawChart(labels, bins);
}

function drawChart(labels, bins) {
    if (chart) {
        chart.destroy();
    }

    chart = new Chart(resultChart.getContext('2d'), {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'توزیع اندازه دانه‌ها (قطر معادل)',
                data: bins,
                backgroundColor: 'rgba(54, 162, 235, 0.6)',
                borderColor: 'rgba(54, 162, 235, 1)',
                borderWidth: 1
            }]
        },
        options: {
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'تعداد سنگ‌ها'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'بازه اندازه (میلی‌متر)'
                    }
                }
            },
            plugins: {
                legend: {
                    display: true
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            label += `${context.raw} عدد`;
                            return label;
                        }
                    }
                }
            }
        }
    });
}