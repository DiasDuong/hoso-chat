const fs = require('fs');
const path = require('path');
const XLSX = require('../../auth-service/node_modules/xlsx');

const fixturesDir = path.join(__dirname);
if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
}

console.log('Generating test fixtures in:', fixturesDir);

// 1. fixture_single_sheet_math.xlsx (1,000 rows with known math, formulas, negatives, decimals)
function generateSingleSheetMath() {
    const wb = XLSX.utils.book_new();
    const rows = [
        ['Mã NV', 'Họ Tên', 'Lương Cơ Bản', 'Thưởng', 'Khấu Trừ', 'Thực Lĩnh', 'Ghi Chú']
    ];

    let sumLuong = 0;
    let sumThuong = 0;
    let sumKhauTru = 0;
    let sumThucLinh = 0;
    let minThucLinh = Infinity;
    let maxThucLinh = -Infinity;

    for (let i = 1; i <= 1000; i++) {
        const id = `NV${String(i).padStart(4, '0')}`;
        const name = `Nhân Viên ${i}`;
        // luong: 10,000,000 to 20,000,000 with decimals
        const luong = 10000000 + (i * 10000) + 0.50;
        // thuong: alternating positive
        const thuong = (i % 2 === 0) ? (2000000 + i * 500) : 0;
        // khautru: negative or deduction
        const khautru = (i % 5 === 0) ? (500000 + i * 100) : 0;
        const thucLinh = luong + thuong - khautru;

        sumLuong += luong;
        sumThuong += thuong;
        sumKhauTru += khautru;
        sumThucLinh += thucLinh;
        if (thucLinh < minThucLinh) minThucLinh = thucLinh;
        if (thucLinh > maxThucLinh) maxThucLinh = thucLinh;

        const ghiChu = (i % 50 === 0) ? '' : `Ghi chú NV ${i}`; // 20 blank cells in Ghi Chú

        rows.push([id, name, luong, thuong, khautru, thucLinh, ghiChu]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);

    // Add explicit formula for row 2 to 1001 for Thực Lĩnh (Col F)
    for (let r = 2; r <= 1001; r++) {
        const cellRef = `F${r}`;
        if (ws[cellRef]) {
            ws[cellRef].f = `C${r}+D${r}-E${r}`; // formula
        }
    }

    XLSX.utils.book_append_sheet(wb, ws, 'Luong_T10_2026');
    const filePath = path.join(fixturesDir, 'fixture_single_sheet_math.xlsx');
    XLSX.writeFile(wb, filePath);

    return {
        file: 'fixture_single_sheet_math.xlsx',
        rowCount: 1000,
        columnCount: 7,
        metrics: {
            sumLuong: Math.round(sumLuong * 100) / 100,
            sumThuong: Math.round(sumThuong * 100) / 100,
            sumKhauTru: Math.round(sumKhauTru * 100) / 100,
            sumThucLinh: Math.round(sumThucLinh * 100) / 100,
            avgThucLinh: Math.round((sumThucLinh / 1000) * 100) / 100,
            minThucLinh: Math.round(minThucLinh * 100) / 100,
            maxThucLinh: Math.round(maxThucLinh * 100) / 100
        }
    };
}

// 2. fixture_multi_sheet_4q.xlsx (4 sheets Q1-Q4)
function generateMultiSheet4Q() {
    const wb = XLSX.utils.book_new();
    const quarters = [
        { name: 'Q1_2026', months: ['Tháng 1', 'Tháng 2', 'Tháng 3'], baseRev: 100000000 },
        { name: 'Q2_2026', months: ['Tháng 4', 'Tháng 5', 'Tháng 6'], baseRev: 120000000 },
        { name: 'Q3_2026', months: ['Tháng 7', 'Tháng 8', 'Tháng 9'], baseRev: 110000000 },
        { name: 'Q4_2026', months: ['Tháng 10', 'Tháng 11', 'Tháng 12'], baseRev: 150000000 }
    ];

    let totalYearRevenue = 0;
    let totalYearCost = 0;
    let totalYearProfit = 0;
    const sheetSummaries = {};

    quarters.forEach((q, qIdx) => {
        const rows = [['Tháng', 'Doanh Thu', 'Chi Phí', 'Lợi Nhuận']];
        let qRev = 0, qCost = 0, qProfit = 0;

        q.months.forEach((m, mIdx) => {
            const rev = q.baseRev + (mIdx + 1) * 5000000;
            const cost = rev * 0.70;
            const profit = rev - cost;

            qRev += rev;
            qCost += cost;
            qProfit += profit;

            rows.push([m, rev, cost, profit]);
        });

        totalYearRevenue += qRev;
        totalYearCost += qCost;
        totalYearProfit += qProfit;

        sheetSummaries[q.name] = {
            rowCount: 3,
            revenue: qRev,
            cost: qCost,
            profit: qProfit
        };

        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, q.name);
    });

    const filePath = path.join(fixturesDir, 'fixture_multi_sheet_4q.xlsx');
    XLSX.writeFile(wb, filePath);

    return {
        file: 'fixture_multi_sheet_4q.xlsx',
        sheetCount: 4,
        totalRows: 12,
        sheets: sheetSummaries,
        yearTotals: {
            revenue: totalYearRevenue,
            cost: totalYearCost,
            profit: totalYearProfit
        }
    };
}

// 3. fixture_sparse_with_errors.xlsx (500 rows, 10 cell errors, 20 blank cells, 5 duplicate rows)
function generateSparseWithErrors() {
    const wb = XLSX.utils.book_new();
    const rows = [
        ['ID', 'Danh Mục', 'Số Lượng', 'Đơn Giá', 'Thành Tiền']
    ];

    let errorCount = 0;
    let blankCount = 0;
    const errorRows = [10, 50, 100, 150, 200, 250, 300, 350, 400, 450]; // 10 errors
    const duplicateRowsIndices = [2, 3, 4, 5, 6]; // 5 rows duplicated

    for (let i = 1; i <= 495; i++) {
        const id = `ITEM_${String(i).padStart(4, '0')}`;
        let category = `Danh mục ${(i % 10) + 1}`;
        let qty = (i % 20) + 1;
        let price = 50000 * ((i % 5) + 1);
        let amount = qty * price;

        if (errorRows.includes(i)) {
            // Error cell
            amount = '#DIV/0!';
            errorCount++;
        } else if (i % 25 === 0 && blankCount < 20) {
            // Blank optional field
            category = '';
            blankCount++;
        }

        rows.push([id, category, qty, price, amount]);
    }

    // Append 5 duplicate rows (copies of row 1..5)
    for (let d = 0; d < 5; d++) {
        const sourceRow = rows[duplicateRowsIndices[d]];
        rows.push([...sourceRow]);
    }

    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');

    const filePath = path.join(fixturesDir, 'fixture_sparse_with_errors.xlsx');
    XLSX.writeFile(wb, filePath);

    return {
        file: 'fixture_sparse_with_errors.xlsx',
        totalRows: 500,
        errorCount: errorCount,
        blankCount: blankCount,
        duplicateCount: 5
    };
}

// Generate all
const groundTruth = {
    generatedAt: new Date().toISOString(),
    singleSheet: generateSingleSheetMath(),
    multiSheet: generateMultiSheet4Q(),
    sparseErrors: generateSparseWithErrors()
};

fs.writeFileSync(
    path.join(fixturesDir, 'fixtures_ground_truth.json'),
    JSON.stringify(groundTruth, null, 2),
    'utf-8'
);

console.log('✅ Generated all fixtures and fixtures_ground_truth.json successfully!');
console.log('Summary:', JSON.stringify(groundTruth, null, 2));
