// --- DOM Elements ---
const imageUpload = document.getElementById('imageUpload');
const imageCanvas = document.getElementById('imageCanvas');
const ctx = imageCanvas.getContext('2d');
const refDiameterInput = document.getElementById('ref-diameter');
const processImageBtn = document.getElementById('process-image-btn');
const addSieveRowBtn = document.getElementById('add-sieve-row');
const sieveTableBody = document.querySelector('#sieve-table tbody');
const calculateSieveBtn = document.getElementById('calculate-sieve-btn');
const loadingDiv = document.getElementById('loading');
const resultChartCanvas = document.getElementById('resultChart');

// --- Result Display Spans ---
const d10Val = document.getElementById('d10-val');
const d30Val = document.getElementById('d30-val');
const d50Val = document.getElementById('d50-val');
const d60Val = document.getElementById('d60-val');
const cuVal = document.getElementById('cu-val');
const ccVal = document.getElementById('cc-val');


// --- State Variables ---
let originalImage = null;
let isDrawing = false;
let startPoint = { x: 0, y: 0 };
let endPoint = { x: 0, y: 0 };
let pixelsPerMm = 0;
let particleSizesMm = [];
let gradationChart = null;

// --- Tab Management ---
function openTab(event, tabName) {
    const tabContents = document.querySelectorAll('.tab-content');
    tabContents.forEach(content => content.classList.remove('active'));
    const tabLinks = document.querySelectorAll('.tab-link');
    tabLinks.forEach(link => link.classList.remove('active'));
    document.getElementById(tabName).classList.add('active');
    event.currentTarget.classList.add('active');
}

// --- OpenCV Ready Callback ---
function onOpenCvReady() {
    console.log('OpenCV.js is ready.');
    processImageBtn.disabled = false;
    loadingDiv.classList.add('hidden');
}

// --- Initial Setup ---
document.addEventListener('DOMContentLoaded', () => {
    processImageBtn.disabled = true;
    loadingDiv.classList.remove('hidden');

    addSieveRowBtn.addEventListener('click', addSieveRow);
    calculateSieveBtn.addEventListener('click', calculateSieveAnalysis);
    imageUpload.addEventListener('change', handleImageUpload);

    imageCanvas.addEventListener('mousedown', startDrawing);
    imageCanvas.addEventListener('mousemove', drawLine);
    imageCanvas.addEventListener('mouseup', stopDrawing);
    imageCanvas.addEventListener('mouseleave', stopDrawing);

    processImageBtn.addEventListener('click', processImage);
});

// --- Image Handling & Drawing ---
function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        originalImage = new Image();
        originalImage.onload = () => {
            imageCanvas.width = originalImage.width;
            imageCanvas.height = originalImage.height;
            redrawCanvas();
        };
        originalImage.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

function redrawCanvas() {
    ctx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
    if (originalImage) {
        ctx.drawImage(originalImage, 0, 0);
    }
}

function startDrawing(e) {
    if (!originalImage) return;
    isDrawing = true;
    startPoint = getMousePos(e);
}

function drawLine(e) {
    if (!isDrawing) return;
    const currentPoint = getMousePos(e);
    redrawCanvas();
    ctx.beginPath();
    ctx.moveTo(startPoint.x, startPoint.y);
    ctx.lineTo(currentPoint.x, currentPoint.y);
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 3;
    ctx.stroke();
}

function stopDrawing(e) {
    if (!isDrawing) return;
    isDrawing = false;
    endPoint = getMousePos(e);
    calculateScale();
}

function getMousePos(e) {
    const rect = imageCanvas.getBoundingClientRect();
    const scaleX = imageCanvas.width / rect.width;
    const scaleY = imageCanvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

function calculateScale() {
    const pixelDistance = Math.sqrt(Math.pow(endPoint.x - startPoint.x, 2) + Math.pow(endPoint.y - startPoint.y, 2));
    const realDiameter = parseFloat(refDiameterInput.value);

    if (pixelDistance > 0 && realDiameter > 0) {
        pixelsPerMm = pixelDistance / realDiameter;
        alert(`مقیاس محاسبه شد: ${pixelsPerMm.toFixed(2)} پیکسل بر میلی‌متر`);
    } else {
        pixelsPerMm = 0;
        alert('امکان محاسبه مقیاس وجود ندارد. لطفاً خط را دوباره رسم کنید و از معتبر بودن قطر مرجع اطمینان حاصل کنید.');
    }
}

// --- Image Analysis ---
function processImage() {
    if (!originalImage) {
        alert('لطفاً ابتدا یک تصویر آپلود کنید.');
        return;
    }
    if (pixelsPerMm === 0) {
        alert('لطفاً با رسم یک خط روی جسم مرجع، مقیاس را مشخص کنید.');
        return;
    }

    loadingDiv.classList.remove('hidden');

    setTimeout(() => {
        try {
            let src = cv.imread(imageCanvas);
            let gray = new cv.Mat();
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

            let blurred = new cv.Mat();
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);

            let thresh = new cv.Mat();
            cv.threshold(blurred, thresh, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            particleSizesMm = [];
            let resultImage = src.clone();

            const minPixelArea = 50;

            for (let i = 0; i < contours.size(); ++i) {
                const cnt = contours.get(i);
                const areaPx = cv.contourArea(cnt);

                if (areaPx > minPixelArea) {
                    const areaMm2 = areaPx / (pixelsPerMm * pixelsPerMm);
                    const equivalentDiameterMm = Math.sqrt(4 * areaMm2 / Math.PI);
                    particleSizesMm.push(equivalentDiameterMm);

                    const rect = cv.boundingRect(cnt);
                    let color = new cv.Scalar(0, 255, 0, 255);
                    cv.rectangle(resultImage, new cv.Point(rect.x, rect.y), new cv.Point(rect.x + rect.width, rect.y + rect.height), color, 2);
                }
                cnt.delete();
            }

            cv.imshow(imageCanvas, resultImage);
            console.log(`پردازش تمام شد. تعداد ${particleSizesMm.length} سنگ پیدا شد.`);

            src.delete(); gray.delete(); blurred.delete(); thresh.delete(); contours.delete(); hierarchy.delete(); resultImage.delete();

            const gradationData = convertSizesToGradation(particleSizesMm);
            calculateAndDisplayResults(gradationData);

        } catch (error) {
            console.error("خطا در پردازش تصویر:", error);
            alert("یک خطای غیرمنتظره در هنگام پردازش تصویر رخ داد.");
        } finally {
            loadingDiv.classList.add('hidden');
        }
    }, 50);
}


// --- Sieve Analysis Logic ---
function addSieveRow() {
    const row = document.createElement('tr');
    row.innerHTML = `
        <td><input type="text" placeholder="e.g., #4"></td>
        <td><input type="number" step="any" placeholder="e.g., 4750"></td>
        <td><input type="number" step="any" placeholder="e.g., 150"></td>
        <td><button onclick="removeSieveRow(this)">حذف</button></td>
    `;
    sieveTableBody.appendChild(row);
}

function removeSieveRow(button) {
    button.closest('tr').remove();
}

function calculateSieveAnalysis() {
    const rows = sieveTableBody.querySelectorAll('tr');
    let sieves = [];
    let totalWeight = 0;

    rows.forEach(row => {
        const sizeUm = parseFloat(row.cells[1].querySelector('input').value);
        const weight = parseFloat(row.cells[2].querySelector('input').value);

        if (!isNaN(sizeUm) && !isNaN(weight)) {
            sieves.push({ size: sizeUm / 1000, weight: weight });
            totalWeight += weight;
        }
    });

    if (sieves.length === 0 || totalWeight === 0) {
        alert('لطفاً اطلاعات سرندها را به درستی وارد کنید.');
        return;
    }

    sieves.sort((a, b) => b.size - a.size);

    let cumulativeWeight = 0;
    const gradationData = sieves.map(sieve => {
        cumulativeWeight += sieve.weight;
        const percentPassing = 100 - (cumulativeWeight / totalWeight) * 100;
        return { size: sieve.size, passing: percentPassing };
    });

    gradationData.unshift({ size: gradationData[0].size * 1.2, passing: 100 });
    gradationData.push({ size: 0.001, passing: 0 }); // Use a small non-zero size for log scale

    calculateAndDisplayResults(gradationData);
}

// --- Calculation and Display Logic ---
function calculateAndDisplayResults(gradationData) {
    if (gradationData.length === 0) return;
    gradationData.sort((a, b) => a.size - b.size);

    const D10 = interpolateLog(gradationData, 10);
    const D30 = interpolateLog(gradationData, 30);
    const D50 = interpolateLog(gradationData, 50);
    const D60 = interpolateLog(gradationData, 60);

    const Cu = (D10 > 0) ? D60 / D10 : 0;
    const Cc = (D10 > 0 && D60 > 0) ? (D30 * D30) / (D10 * D60) : 0;

    d10Val.textContent = D10.toFixed(2);
    d30Val.textContent = D30.toFixed(2);
    d50Val.textContent = D50.toFixed(2);
    d60Val.textContent = D60.toFixed(2);
    cuVal.textContent = Cu.toFixed(2);
    ccVal.textContent = Cc.toFixed(2);

    displayChart(gradationData);
}

function interpolateLog(data, targetPassing) {
    let p1 = null, p2 = null;
    for (let i = 0; i < data.length - 1; i++) {
        if (data[i].passing <= targetPassing && data[i+1].passing >= targetPassing) {
            p1 = data[i];
            p2 = data[i+1];
            break;
        }
    }

    if (!p1 || !p2 || p1.passing === p2.passing) {
        if (targetPassing <= data[0].passing) return data[0].size;
        if (targetPassing >= data[data.length - 1].passing) return data[data.length - 1].size;
        return 0;
    }

    // Ensure sizes are not zero for log
    const size1 = p1.size > 0 ? p1.size : 0.001;
    const size2 = p2.size > 0 ? p2.size : 0.001;

    const logD1 = Math.log10(size1);
    const logD2 = Math.log10(size2);

    const result = Math.pow(10, logD1 + (logD2 - logD1) * (targetPassing - p1.passing) / (p2.passing - p1.passing));
    return result;
}

function convertSizesToGradation(sizes) {
    if (sizes.length === 0) return [];

    const sortedSizes = [...sizes].sort((a, b) => a - b);
    const totalCount = sortedSizes.length;

    const gradationData = [];
    for (let i = 0; i < totalCount; i++) {
        const percentPassing = (i / totalCount) * 100;
        gradationData.push({ size: sortedSizes[i], passing: percentPassing });
    }

    gradationData.push({ size: sortedSizes[totalCount - 1], passing: 100 });
    gradationData.unshift({ size: 0.001, passing: 0 });

    return gradationData;
}

// --- Charting Logic ---
function displayChart(gradationData) {
    if (gradationChart) {
        gradationChart.destroy();
    }

    const chartData = gradationData.map(d => ({ x: d.size, y: d.passing }));

    gradationChart = new Chart(resultChartCanvas, {
        type: 'line',
        data: {
            datasets: [{
                label: 'نمودار دانه‌بندی',
                data: chartData,
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.5)',
                fill: false,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: {
                    type: 'logarithmic',
                    title: {
                        display: true,
                        text: 'اندازه دانه (میلی‌متر) - مقیاس لگاریتمی'
                    },
                    afterBuildTicks: (axis) => {
                        axis.ticks = axis.ticks.filter(tick => tick.value > 0);
                    }
                },
                y: {
                    min: 0,
                    max: 100,
                    title: {
                        display: true,
                        text: 'درصد عبوری (%)'
                    }
                }
            }
        }
    });
}