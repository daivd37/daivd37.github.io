/**
 * 내연기관차 vs 전기차 생애주기 CO₂ 비교 계산기
 * 
 * 이 애플리케이션은 생애주기 분석을 사용하여 내연기관차(ICE)와 배터리 전기차(BEV)의
 * 다양한 거리에서 누적 CO₂ 배출량을 비교합니다.
 * 
 * 구현된 수학 공식:
 * - ICE 누적: E_ICE(d) = E_manuf,veh^ICE + d × (ℓ/100) × α_fuel
 * - BEV 누적: E_BEV(d) = (E_manuf,veh^BEV + α_bat) + d × (e/100) × α_grid
 * - km당 배출강도: k_ICE = (ℓ/100) × α_fuel, k_BEV = (e/100) × α_grid
 * - (수정) k_ICE = (1/연비) x 30.1(1L 당 발열량) x 19.731(탄소배출계수) / 1000000 x 44/12(탄소->이산화탄소)
 * - 손익분기점: d* = ((E_manuf,veh^BEV + α_bat) − E_manuf,veh^ICE) / (k_ICE − k_BEV)
 */

// Global state
let currentResults = null;
let chart = null;

// DOM elements
const form = document.getElementById('comparison-form');
const computeBtn = document.getElementById('compute-btn');
const resetBtn = document.getElementById('reset-btn');
const downloadCsvBtn = document.getElementById('download-csv-btn');
const copyUrlBtn = document.getElementById('copy-url-btn');
const resultsSection = document.getElementById('results');
const canvas = document.getElementById('emissions-chart');

/**
 * 누락된 매개변수에 대한 추정 휴리스틱
 */
const EstimationHeuristics = {
    /**
     * 제조 CO₂ (배터리 제외 차량): E_manuf_veh ≈ 1.46 × 공차중량_kg (전로 생산방식 이산화탄소 배출 계수 1.46CO2t/t)
     */
    estimateManufacturingCO2: (weight) => 1.46 * weight,
    
    /**
     * ICE 연비: ℓ ≈ 3.5 + 2.5 × (공차중량_kg / 1000)
     */
    estimateICEFuelEconomy: (weight) => 3.5 + 2.5 * (weight / 1000),
    
    /**
     * BEV 에너지 사용량: e ≈ 6.0 + 0.006 × 공차중량_kg
     */
    estimateBEVEnergyUse: (weight) => 6.0 + 0.006 * weight,
    
    /**
     * BEV 배터리 용량: 배터리_kWh ≈ clamp(0.04 × 공차중량_kg, 45, 95)
     */
    estimateBEVBatteryCapacity: (weight) => Math.max(45, Math.min(95, 0.04 * weight))
};

/**
 * 입력 검증 및 파싱
 */
const InputParser = {
    /**
     * 쉼표로 구분된 거리 문자열 파싱
     */
    parseDistances: (distancesStr) => {
        if (!distancesStr.trim()) {
            throw new Error('거리는 비어있을 수 없습니다');
        }
        
        const distances = distancesStr.split(',')
            .map(d => d.trim())
            .map(d => parseFloat(d))
            .filter(d => !isNaN(d) && d >= 0)
            .sort((a, b) => a - b);
            
        if (distances.length === 0) {
            throw new Error('유효한 거리를 찾을 수 없습니다');
        }
        
        return distances;
    },
    
    /**
     * 검증과 함께 숫자 입력 파싱
     */
    parseNumber: (value, fieldName, min = 0) => {
        if (!value || value.trim() === '') {
            return null; // 선택적 필드
        }
        
        const num = parseFloat(value);
        if (isNaN(num) || num < min) {
            throw new Error(`${fieldName}은(는) ${min} 이상의 숫자여야 합니다`);
        }
        
        return num;
    },
    
    /**
     * 모든 폼 입력 파싱
     */
    parseFormInputs: () => {
        const formData = new FormData(form);
        
        try {
            const distances = InputParser.parseDistances(formData.get('distances'));
            
            // 공통 매개변수
            const alphaFuel = InputParser.parseNumber(formData.get('alpha-fuel'), 'α_fuel') || 2.18;
            const alphaGrid = InputParser.parseNumber(formData.get('alpha-grid'), 'α_grid') || 0.45;
            const phiGrid = InputParser.parseNumber(formData.get('phi-grid'), 'φ_grid') || 8.5;
            const alphaBatPerKwh = InputParser.parseNumber(formData.get('alpha-bat-per-kwh'), 'α_bat_per_kWh') || 80;
            
            // ICE 매개변수
            const iceWeight = InputParser.parseNumber(formData.get('ice-weight'), 'ICE 중량');
            if (!iceWeight) throw new Error('ICE 중량은 필수입니다');
            
            const iceFuelEconomy = InputParser.parseNumber(formData.get('ice-fuel-economy'), 'ICE 연비');
            const iceManufacturing = InputParser.parseNumber(formData.get('ice-manufacturing'), 'ICE 제조 CO₂');
            
            // BEV 매개변수
            const bevWeight = InputParser.parseNumber(formData.get('bev-weight'), 'BEV 중량');
            if (!bevWeight) throw new Error('BEV 중량은 필수입니다');
            
            const bevEnergyUse = InputParser.parseNumber(formData.get('bev-energy-use'), 'BEV 에너지 사용량');
            const bevBatteryCapacity = InputParser.parseNumber(formData.get('bev-battery-capacity'), 'BEV 배터리 용량');
            const bevManufacturing = InputParser.parseNumber(formData.get('bev-manufacturing'), 'BEV 제조 CO₂');
            
            return {
                distances,
                alphaFuel,
                alphaGrid,
                phiGrid,
                alphaBatPerKwh,
                iceWeight,
                iceFuelEconomy,
                iceManufacturing,
                bevWeight,
                bevEnergyUse,
                bevBatteryCapacity,
                bevManufacturing
            };
        } catch (error) {
            throw new Error(`입력 검증 오류: ${error.message}`);
        }
    }
};

/**
 * 계산 엔진
 */
const Calculator = {
    /**
     * 누락된 매개변수에 대한 파생 값 계산
     */
    calculateDerivedValues: (inputs) => {
        const derived = {};
        
        // ICE 파생 값
        if (inputs.iceFuelEconomy === null) {
            derived.iceFuelEconomy = EstimationHeuristics.estimateICEFuelEconomy(inputs.iceWeight);
        }
        if (inputs.iceManufacturing === null) {
            derived.iceManufacturing = EstimationHeuristics.estimateManufacturingCO2(inputs.iceWeight);
        }
        
        // BEV 파생 값
        if (inputs.bevEnergyUse === null) {
            derived.bevEnergyUse = EstimationHeuristics.estimateBEVEnergyUse(inputs.bevWeight);
        }
        if (inputs.bevBatteryCapacity === null) {
            derived.bevBatteryCapacity = EstimationHeuristics.estimateBEVBatteryCapacity(inputs.bevWeight);
        }
        if (inputs.bevManufacturing === null) {
            derived.bevManufacturing = EstimationHeuristics.estimateManufacturingCO2(inputs.bevWeight);
        }
        
        return derived;
    },
    
    /**
     * km당 배출강도 계산
     */
    calculatePerKmIntensities: (inputs, derived) => {
        const iceFuelEconomy = inputs.iceFuelEconomy ?? derived.iceFuelEconomy;
        const bevEnergyUse = inputs.bevEnergyUse ?? derived.bevEnergyUse;
        
        const kICE = (1 / iceFuelEconomy) * inputs.alphaFuel;
        const kBEV = (1 / bevEnergyUse) * inputs.alphaGrid;
        
        return { kICE, kBEV };
    },
    
    /**
     * 손익분기점 거리 계산
     */
    calculateBreakEven: (inputs, derived, kICE, kBEV) => {
        const iceManufacturing = inputs.iceManufacturing ?? derived.iceManufacturing;
        const bevManufacturing = inputs.bevManufacturing ?? derived.bevManufacturing;
        const bevBatteryCapacity = inputs.bevBatteryCapacity ?? derived.bevBatteryCapacity;
        
        const alphaBat = bevBatteryCapacity * inputs.alphaBatPerKwh;
        const deltaManuf = (bevManufacturing + alphaBat) - iceManufacturing;
        
        if (kICE <= kBEV) {
            return {
                breakEven: null,
                message: kICE < kBEV ? 
                    '유한한 손익분기점 없음 (BEV의 km당 배출강도가 더 낮지 않음)' :
                    '이미 d=0에서 더 좋음 (동일한 km당 배출강도)',
                deltaManuf
            };
        }
        
        const breakEven = deltaManuf / (kICE - kBEV);
        
        return {
            breakEven: breakEven >= 0 ? breakEven : null,
            message: breakEven >= 0 ? 
                `${breakEven.toFixed(0)} km에서 손익분기점` :
                'BEV가 0 km에서 더 좋음',
            deltaManuf
        };
    },
    
    /**
     * 모든 거리에 대한 누적 배출량 계산
     */
    calculateCumulativeEmissions: (inputs, derived, kICE, kBEV) => {
        const iceManufacturing = inputs.iceManufacturing ?? derived.iceManufacturing;
        const bevManufacturing = inputs.bevManufacturing ?? derived.bevManufacturing;
        const bevBatteryCapacity = inputs.bevBatteryCapacity ?? derived.bevBatteryCapacity;
        const bevEnergyUse = inputs.bevEnergyUse ?? derived.bevEnergyUse;
        
        const alphaBat = bevBatteryCapacity * inputs.alphaBatPerKwh;
        
        return inputs.distances.map(distance => {
            const eICE = iceManufacturing + distance * kICE;
            const eBEV = (bevManufacturing + alphaBat) + distance * kBEV;
            const delta = eBEV - eICE;
            const peBEV = distance * (bevEnergyUse / 100) * inputs.phiGrid;
            
            return {
                distance,
                eICE,
                eBEV,
                delta,
                kICE,
                kBEV,
                peBEV
            };
        });
    },
    
    /**
     * 메인 계산 함수
     */
    calculate: (inputs) => {
        const derived = Calculator.calculateDerivedValues(inputs);
        const { kICE, kBEV } = Calculator.calculatePerKmIntensities(inputs, derived);
        const breakEvenResult = Calculator.calculateBreakEven(inputs, derived, kICE, kBEV);
        const results = Calculator.calculateCumulativeEmissions(inputs, derived, kICE, kBEV);
        
        return {
            inputs,
            derived,
            kICE,
            kBEV,
            breakEven: breakEvenResult.breakEven,
            breakEvenMessage: breakEvenResult.message,
            deltaManuf: breakEvenResult.deltaManuf,
            results
        };
    }
};

/**
 * UI 렌더링 함수
 */
const UIRenderer = {
    /**
     * 검증 오류 표시
     */
    showError: (message) => {
        // 기존 오류 메시지 제거
        const existingErrors = document.querySelectorAll('.error-message');
        existingErrors.forEach(el => el.remove());
        
        // 새 오류 메시지 생성
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.style.cssText = `
            background: var(--danger-color);
            color: white;
            padding: var(--spacing-md);
            border-radius: var(--border-radius-md);
            margin-bottom: var(--spacing-md);
            font-weight: 500;
        `;
        errorDiv.textContent = message;
        
        // 폼 상단에 삽입
        form.insertBefore(errorDiv, form.firstChild);
        
        // 오류로 스크롤
        errorDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    
    /**
     * 주요 지표 표시 업데이트
     */
    updateKeyMetrics: (results) => {
        document.getElementById('k-ice-value').textContent = results.kICE.toFixed(3);
        document.getElementById('k-bev-value').textContent = results.kBEV.toFixed(3);
        document.getElementById('delta-manuf-value').textContent = results.deltaManuf.toFixed(0);
        document.getElementById('break-even-message').textContent = results.breakEvenMessage;
        
        // 결과에 따라 손익분기점 메시지 스타일링
        const breakEvenEl = document.getElementById('break-even-message');
        breakEvenEl.className = '';
        if (results.breakEven === null) {
            if (results.breakEvenMessage.includes('유한한 손익분기점 없음')) {
                breakEvenEl.classList.add('text-warning');
            } else {
                breakEvenEl.classList.add('text-success');
            }
        } else {
            breakEvenEl.classList.add('text-success');
        }
    },
    
    /**
     * 추정된 값 표시 업데이트
     */
    updateDerivedValues: (inputs, derived) => {
        const container = document.getElementById('derived-values-content');
        container.innerHTML = '';
        
        const derivedItems = [];
        
        // ICE 추정된 값
        if (inputs.iceFuelEconomy === null) {
            derivedItems.push(`ICE 연비: ${derived.iceFuelEconomy.toFixed(1)} L/100 km`);
        }
        if (inputs.iceManufacturing === null) {
            derivedItems.push(`ICE 제조 CO₂: ${derived.iceManufacturing.toFixed(0)} kgCO₂e`);
        }
        
        // BEV 추정된 값
        if (inputs.bevEnergyUse === null) {
            derivedItems.push(`BEV 에너지 사용량: ${derived.bevEnergyUse.toFixed(1)} kWh/100 km`);
        }
        if (inputs.bevBatteryCapacity === null) {
            derivedItems.push(`BEV 배터리 용량: ${derived.bevBatteryCapacity.toFixed(0)} kWh`);
        }
        if (inputs.bevManufacturing === null) {
            derivedItems.push(`BEV 제조 CO₂: ${derived.bevManufacturing.toFixed(0)} kgCO₂e`);
        }
        
        if (derivedItems.length > 0) {
            derivedItems.forEach(item => {
                const span = document.createElement('span');
                span.className = 'derived-value';
                span.textContent = item;
                container.appendChild(span);
            });
        } else {
            container.innerHTML = '<p>추정된 값 없음 (모든 입력값 제공됨)</p>';
        }
    },
    
    /**
     * 결과 표 업데이트
     */
    updateResultsTable: (results) => {
        const tbody = document.querySelector('#results-table tbody');
        tbody.innerHTML = '';
        
        results.forEach(row => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${row.distance.toLocaleString()}</td>
                <td>${row.eICE.toFixed(0)}</td>
                <td>${row.eBEV.toFixed(0)}</td>
                <td class="${row.delta >= 0 ? 'text-danger' : 'text-success'}">${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(0)}</td>
                <td>${row.kICE.toFixed(3)}</td>
                <td>${row.kBEV.toFixed(3)}</td>
                <td>${row.peBEV.toFixed(0)}</td>
            `;
            tbody.appendChild(tr);
        });
    },
    
    /**
     * 결과 섹션 표시
     */
    showResults: () => {
        resultsSection.style.display = 'block';
        resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
};

/**
 * Canvas 2D를 사용한 차트 렌더링
 */
const ChartRenderer = {
    /**
     * 차트 초기화
     */
    init: () => {
        const ctx = canvas.getContext('2d');
        chart = { ctx, canvas };
    },
    
    /**
     * 캔버스 지우기
     */
    clear: () => {
        const { ctx, canvas } = chart;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    
    /**
     * 배출량 데이터로 차트 그리기
     */
    draw: (results, breakEven) => {
        const { ctx, canvas } = chart;
        const padding = 60;
        const chartWidth = canvas.width - 2 * padding;
        const chartHeight = canvas.height - 2 * padding;
        
        // 캔버스 지우기
        ChartRenderer.clear();
        
        // 데이터 범위 찾기
        const distances = results.map(r => r.distance);
        const emissions = results.map(r => [r.eICE, r.eBEV]).flat();
        
        const minDistance = Math.min(...distances);
        const maxDistance = Math.max(...distances);
        const minEmission = Math.min(...emissions);
        const maxEmission = Math.max(...emissions);
        
        // 범위에 여백 추가
        const distanceRange = maxDistance - minDistance;
        const emissionRange = maxEmission - minEmission;
        const paddedMinDistance = Math.max(0, minDistance - distanceRange * 0.05);
        const paddedMaxDistance = maxDistance + distanceRange * 0.05;
        const paddedMinEmission = Math.max(0, minEmission - emissionRange * 0.1);
        const paddedMaxEmission = maxEmission + emissionRange * 0.1;
        
        // 스케일 함수
        const scaleX = (distance) => padding + (distance - paddedMinDistance) / (paddedMaxDistance - paddedMinDistance) * chartWidth;
        const scaleY = (emission) => canvas.height - padding - (emission - paddedMinEmission) / (paddedMaxEmission - paddedMinEmission) * chartHeight;
        
        // 격자 그리기
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        
        // 세로 격자선
        const distanceStep = Math.pow(10, Math.floor(Math.log10(distanceRange)));
        for (let d = Math.ceil(paddedMinDistance / distanceStep) * distanceStep; d <= paddedMaxDistance; d += distanceStep) {
            const x = scaleX(d);
            ctx.beginPath();
            ctx.moveTo(x, padding);
            ctx.lineTo(x, canvas.height - padding);
            ctx.stroke();
        }
        
        // 가로 격자선
        const emissionStep = Math.pow(10, Math.floor(Math.log10(emissionRange)));
        for (let e = Math.ceil(paddedMinEmission / emissionStep) * emissionStep; e <= paddedMaxEmission; e += emissionStep) {
            const y = scaleY(e);
            ctx.beginPath();
            ctx.moveTo(padding, y);
            ctx.lineTo(canvas.width - padding, y);
            ctx.stroke();
        }
        
        // 축 그리기
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        
        // X축
        ctx.beginPath();
        ctx.moveTo(padding, canvas.height - padding);
        ctx.lineTo(canvas.width - padding, canvas.height - padding);
        ctx.stroke();
        
        // Y축
        ctx.beginPath();
        ctx.moveTo(padding, padding);
        ctx.lineTo(padding, canvas.height - padding);
        ctx.stroke();
        
        // ICE 선 그리기
        ctx.strokeStyle = '#fd7e14';
        ctx.lineWidth = 3;
        ctx.beginPath();
        results.forEach((result, i) => {
            const x = scaleX(result.distance);
            const y = scaleY(result.eICE);
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();
        
        // BEV 선 그리기
        ctx.strokeStyle = '#20c997';
        ctx.lineWidth = 3;
        ctx.beginPath();
        results.forEach((result, i) => {
            const x = scaleX(result.distance);
            const y = scaleY(result.eBEV);
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        });
        ctx.stroke();
        
        // 손익분기점 선 그리기 (해당하는 경우)
        if (breakEven !== null && breakEven >= 0) {
            const x = scaleX(breakEven);
            ctx.strokeStyle = '#dc3545';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(x, padding);
            ctx.lineTo(x, canvas.height - padding);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // 손익분기점 라벨 추가
            ctx.fillStyle = '#dc3545';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`손익분기점: ${breakEven.toFixed(0)} km`, x, padding - 10);
        }
        
        // 데이터 포인트 그리기
        results.forEach(result => {
            const x = scaleX(result.distance);
            
            // ICE 포인트
            ctx.fillStyle = '#fd7e14';
            ctx.beginPath();
            ctx.arc(x, scaleY(result.eICE), 4, 0, 2 * Math.PI);
            ctx.fill();
            
            // BEV 포인트
            ctx.fillStyle = '#20c997';
            ctx.beginPath();
            ctx.arc(x, scaleY(result.eBEV), 4, 0, 2 * Math.PI);
            ctx.fill();
        });
        
        // 축 라벨 그리기
        ctx.fillStyle = '#333';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('거리 (km)', canvas.width / 2, canvas.height - 10);
        
        ctx.save();
        ctx.translate(20, canvas.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('누적 CO₂ 배출량 (kgCO₂e)', 0, 0);
        ctx.restore();
        
        // 범례 그리기
        const legendY = 30;
        const legendX = canvas.width - 150;
        
        // ICE 범례
        ctx.fillStyle = '#fd7e14';
        ctx.fillRect(legendX, legendY, 15, 3);
        ctx.fillStyle = '#333';
        ctx.textAlign = 'left';
        ctx.fillText('ICE', legendX + 20, legendY + 10);
        
        // BEV 범례
        ctx.fillStyle = '#20c997';
        ctx.fillRect(legendX, legendY + 20, 15, 3);
        ctx.fillStyle = '#333';
        ctx.fillText('BEV', legendX + 20, legendY + 30);
        
        // 축 값 추가
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        
        // X축 값
        for (let d = Math.ceil(paddedMinDistance / distanceStep) * distanceStep; d <= paddedMaxDistance; d += distanceStep) {
            const x = scaleX(d);
            ctx.fillText(d.toLocaleString(), x, canvas.height - padding + 20);
        }
        
        // Y축 값
        ctx.textAlign = 'right';
        for (let e = Math.ceil(paddedMinEmission / emissionStep) * emissionStep; e <= paddedMaxEmission; e += emissionStep) {
            const y = scaleY(e);
            ctx.fillText(e.toLocaleString(), padding - 10, y + 3);
        }
    }
};

/**
 * 내보내기 기능
 */
const Exporter = {
    /**
     * 결과를 CSV로 내보내기
     */
    exportToCSV: (results) => {
        const headers = [
            '거리 (km)',
            'E_ICE(d) (kgCO₂e)',
            'E_BEV(d) (kgCO₂e)',
            'Δ (BEV - ICE) (kgCO₂e)',
            'k_ICE (kgCO₂e/km)',
            'k_BEV (kgCO₂e/km)',
            'PE_BEV(d) (MJ)'
        ];
        
        const csvContent = [
            headers.join(','),
            ...results.map(row => [
                row.distance,
                row.eICE.toFixed(0),
                row.eBEV.toFixed(0),
                row.delta.toFixed(0),
                row.kICE.toFixed(3),
                row.kBEV.toFixed(3),
                row.peBEV.toFixed(0)
            ].join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', 'ice_vs_bev_emissions.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
};

/**
 * URL 상태 관리
 */
const URLState = {
    /**
     * 현재 폼 상태를 URL 매개변수로 인코딩
     */
    encodeToURL: () => {
        const formData = new FormData(form);
        const params = new URLSearchParams();
        
        // 모든 폼 필드를 URL에 추가
        for (const [key, value] of formData.entries()) {
            if (value.trim() !== '') {
                params.set(key, value);
            }
        }
        
        return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
    },
    
    /**
     * URL 매개변수를 폼 상태로 디코딩
     */
    decodeFromURL: () => {
        const params = new URLSearchParams(window.location.search);
        
        // 기존 오류 메시지 지우기
        const existingErrors = document.querySelectorAll('.error-message');
        existingErrors.forEach(el => el.remove());
        
        // URL 매개변수에서 폼 값 설정
        for (const [key, value] of params.entries()) {
            const input = form.querySelector(`[name="${key}"]`);
            if (input) {
                input.value = value;
            }
        }
    },
    
    /**
     * 공유 URL을 클립보드에 복사
     */
    copyShareURL: async () => {
        try {
            const url = URLState.encodeToURL();
            await navigator.clipboard.writeText(url);
            
            // 성공 피드백 표시
            const originalText = copyUrlBtn.textContent;
            copyUrlBtn.textContent = 'URL 복사됨!';
            copyUrlBtn.style.backgroundColor = 'var(--success-color)';
            
            setTimeout(() => {
                copyUrlBtn.textContent = originalText;
                copyUrlBtn.style.backgroundColor = '';
            }, 2000);
        } catch (error) {
            console.error('URL 복사 실패:', error);
            // 구형 브라우저용 대체 방법
            const url = URLState.encodeToURL();
            const textArea = document.createElement('textarea');
            textArea.value = url;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            
            copyUrlBtn.textContent = 'URL 복사됨!';
            setTimeout(() => {
                copyUrlBtn.textContent = '공유 URL 복사';
            }, 2000);
        }
    }
};

/**
 * 폼 초기화 기능
 */
const FormReset = {
    /**
     * 폼을 기본값으로 초기화
     */
    reset: () => {
        // 모든 입력 지우기
        form.reset();
        
        // 기본값 설정
        document.getElementById('distances').value = '0,20000,40000,60000,100000';
        document.getElementById('alpha-fuel').value = '2.7';
        document.getElementById('alpha-grid').value = '0.45';
        document.getElementById('phi-grid').value = '8.5';
        document.getElementById('alpha-bat-per-kwh').value = '80';
        document.getElementById('ice-weight').value = '1750';
        document.getElementById('bev-weight').value = '1900';
        
        // 결과 지우기
        resultsSection.style.display = 'none';
        currentResults = null;
        
        // 차트 지우기
        if (chart) {
            ChartRenderer.clear();
        }
        
        // 오류 메시지 지우기
        const existingErrors = document.querySelectorAll('.error-message');
        existingErrors.forEach(el => el.remove());
        
        // URL 매개변수 지우기
        window.history.replaceState({}, document.title, window.location.pathname);
    }
};

/**
 * 메인 계산 함수
 */
const computeResults = () => {
    try {
        // 기존 오류 메시지 제거
        const existingErrors = document.querySelectorAll('.error-message');
        existingErrors.forEach(el => el.remove());
        
        // 입력 파싱
        const inputs = InputParser.parseFormInputs();
        
        // 결과 계산
        const results = Calculator.calculate(inputs);
        currentResults = results;
        
        // UI 업데이트
        UIRenderer.updateKeyMetrics(results);
        UIRenderer.updateDerivedValues(inputs, results.derived);
        UIRenderer.updateResultsTable(results.results);
        UIRenderer.showResults();
        
        // 차트 그리기
        ChartRenderer.draw(results.results, results.breakEven);
        
    } catch (error) {
        UIRenderer.showError(error.message);
        console.error('계산 오류:', error);
    }
};

/**
 * 이벤트 리스너
 */
const setupEventListeners = () => {
    // 계산 버튼
    computeBtn.addEventListener('click', computeResults);
    
    // 초기화 버튼
    resetBtn.addEventListener('click', FormReset.reset);
    
    // CSV 다운로드 버튼
    downloadCsvBtn.addEventListener('click', () => {
        if (currentResults) {
            Exporter.exportToCSV(currentResults.results);
        } else {
            UIRenderer.showError('내보낼 결과가 없습니다. 먼저 계산해주세요.');
        }
    });
    
    // URL 복사 버튼
    copyUrlBtn.addEventListener('click', URLState.copyShareURL);
    
    // 폼 제출 (기본 동작 방지)
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        computeResults();
    });
    
    // 입력에서 Enter 키로 계산 트리거
    form.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            computeResults();
        }
    });
};

/**
 * 애플리케이션 초기화
 */
const init = () => {
    // 차트 초기화
    ChartRenderer.init();
    
    // 이벤트 리스너 설정
    setupEventListeners();
    
    // URL에 상태가 있으면 로드
    if (window.location.search) {
        URLState.decodeFromURL();
    }
    
    // URL에 매개변수가 있으면 로드 시 자동 계산
    if (window.location.search) {
        computeResults();
    }
};

// DOM 로드 시 초기화
document.addEventListener('DOMContentLoaded', init);
