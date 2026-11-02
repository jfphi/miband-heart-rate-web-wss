/** Confirmed wrist devices for the standard BLE Heart Rate Service (0x180D). */
export const DEVICE_BRANDS = [
  {
    brand: '小米',
    supported: [
      '手環 3',
      '手環 9（韌體 1.3.206 起）',
      '手環 9 Pro（韌體 1.3.153 起）',
      '手環 10、10 NFC、10 陶瓷版、10 耀影金',
    ],
    unsupported: ['手環 7', '手環 7 Pro', '手環 8', '手環 8 Active', '手環 8 Pro'],
  },
  {
    brand: 'Amazfit',
    supported: [
      'Band 5',
      '初代 Bip',
      'Neo（先在 Zepp 打開可被發現與活動心率分享）',
      'Active、Active 2（圓錶與方錶）',
      'Bip 6',
      'Balance、Balance 2',
      'GTR 4、GTS 4',
      'T-Rex 3、T-Rex Ultra',
      'Helio Strap',
    ],
    unsupported: [],
  },
  {
    brand: 'Garmin',
    supported: [
      'Forerunner 55、245、255、265、745、945、955、965',
      'fēnix 6、fēnix 6 Pro、fēnix 7、fēnix 8',
      'Instinct 2',
      'Venu 2、Venu 3、Venu 4',
      'vívoactive 5、vívoactive 6',
    ],
    unsupported: [
      'fēnix 5 及更早（只廣播 ANT+）',
      'Forerunner 235（只廣播 ANT+）',
      'vívoactive 4 及同系列更早款（只廣播 ANT+）',
      'Lily 全系列（只廣播 ANT+）',
      'vívomove 全系列（只廣播 ANT+）',
    ],
  },
  {
    brand: 'Polar',
    supported: ['Ignite 2', 'Pacer'],
    unsupported: [],
  },
  {
    brand: 'Suunto',
    supported: ['Race、Race S、Race 2、Vertical 2（需有心率廣播的韌體，並在運動模式開啟）'],
    unsupported: ['9 Peak Pro', 'Vertical 初代'],
  },
  {
    brand: '華為',
    supported: [
      'Band 8、9、10、11',
      'Watch Fit 3、WATCH FIT、WATCH D',
      'WATCH GT 3、WATCH GT 4',
      'WATCH D2',
      'WATCH 5、WATCH Ultimate 2（省電模式才看得到心率廣播）',
    ],
    unsupported: [],
  },
  {
    brand: 'Fitbit／Google',
    supported: ['Charge 6', 'Fitbit Air', 'Pixel Watch 2 及之後'],
    unsupported: [
      'Charge 5 及更早',
      'Sense、Sense 2',
      'Versa、Versa 4',
      'Inspire',
      'Luxe',
    ],
  },
  {
    brand: 'WHOOP',
    supported: ['3.0、4.0、5.0（在 WHOOP App 打開 Broadcast Heart Rate）'],
    unsupported: [],
  },
  {
    brand: '迪卡儂',
    supported: ['HRM Band'],
    unsupported: [],
  },
  {
    brand: '三星',
    supported: ['Galaxy Watch 4 及之後（手錶需安裝 Heart for Bluetooth）'],
    unsupported: ['Galaxy Watch 3', 'Galaxy Watch Active2 及更早'],
  },
  {
    brand: 'Apple',
    supported: [],
    unsupported: ['Apple Watch 全系列，含 SE 與 Ultra'],
  },
];

export const DEVICE_SUPPORT_NOTE =
  'COROS 有藍牙心率廣播，但沒有逐型號的確認清單，所以不列入可以或不行。未出現在上面的型號也尚未確認。';

function listItems(items) {
  return items.map((item) => `<li>${item}</li>`).join('');
}

function brandBlock(entry) {
  const parts = [`<h3>${entry.brand}</h3>`];
  if (entry.supported.length) {
    parts.push(`<p class="brand-label">可以</p><ul>${listItems(entry.supported)}</ul>`);
  }
  if (entry.unsupported.length) {
    parts.push(`<p class="brand-label">不行</p><ul>${listItems(entry.unsupported)}</ul>`);
  }
  return `<div class="brand-block">${parts.join('')}</div>`;
}

export function renderDeviceSupport(root, noteEl) {
  if (root) root.innerHTML = DEVICE_BRANDS.map(brandBlock).join('');
  if (noteEl) noteEl.textContent = DEVICE_SUPPORT_NOTE;
}
