// cars.js — the cars of the game: looks (file, credits), driving stats, price in the upgrader and talents.
//
// Stats are relative to the reference car (≈1150 hp, 1765 kg, 2.4 grip of the old tuned Ferrari):
//   accel – power-to-weight (1 = 0-100 in ~2.1 s), top – km/h on the limiter in 6th, grip – tyre grip,
//   steer – steering lock, mass – kg (who pushes whom in a crash), armor – damage taken (0.5 = half).
// Prices: chance in the upgrader = bet ÷ price (max 80%). With the ~350 a player has in round 1 the best car of each
// list is a 7–9% long shot. brPrice: the battle royale, where everyone can win any car — the two hunters' armoured
// cars are the strongest there, so they cost the most.

export const TALENTS = {
  oil:        { name: 'Масляное пятно', desc: 'Лужа масла сзади: кто наедет — теряет сцепление', charges: 2 },
  repair:     { name: 'Ремкомплект', desc: 'Чинит машину на ходу: все повреждённые детали наполовину (водителя не вернуть)', charges: 1 },
  smoke:      { name: 'Дымовая завеса', desc: 'Облако дыма за машиной закрывает обзор', charges: 2 },
  swapRunner: { name: 'Подмена', desc: 'Меняешься местами с другим убегающим', charges: 1, minRunners: 2,
                descBr: 'Меняешься местами с соперником, который дальше всех от твоего ближайшего врага' },
  jump:       { name: 'Прыжок', desc: 'Подбрасывает машину — можно перепрыгнуть ловца', cooldown: 15,
                descBr: 'Подбрасывает машину — можно перепрыгнуть соперника' },
  flip:       { name: 'Подбрасыватель', desc: 'Гидравлическая плита спереди подбрасывает машину перед тобой', cooldown: 5 },
  decoy:      { name: 'Клон', desc: 'Копия твоей машины уезжает в сторону и отвлекает ловца', charges: 2,
                descBr: 'Копия твоей машины уезжает в сторону и отвлекает соперников' },
  nitro:      { name: 'Турбо-ускорение', desc: '3 секунды мощного ускорения', charges: 2 },
  swapHunter: { name: 'Обмен с ловцом', desc: 'Меняешься местами с ловцом (если он дальше 30 м)', charges: 1,
                nameBr: 'Обмен', descBr: 'Меняешься местами с ближайшим соперником (если он дальше 30 м)' },
  spikes:     { name: 'Шипы', desc: 'Полоса шипов впереди пробивает колёса', charges: 2 },
  glue:       { name: 'Клей', desc: 'Лужа клея впереди сильно тормозит', charges: 2 },
  harpoon:    { name: 'Гарпун', desc: 'Цепляет убегающего впереди (до 30 м) и тянет к тебе', charges: 2,
                descBr: 'Цепляет машину впереди (до 30 м) и тянет к тебе' },
  ram:        { name: 'Таран', desc: 'Удары на 50% сильнее, себе урона вдвое меньше', passive: true },
};

export const CARS = {
  // ------------------------------------------------ runners (all start in the cheapest one)
  smallcar:   { name: 'Small Price Car', role: 'runner', price: 0, brPrice: 0, talent: null, engine: 'front',
                accel: 0.55, top: 175, grip: 0.86, steer: 1.0, mass: 1050, armor: 1.2, downforce: 0.9,
                credit: 'Oliv1e (CC BY 4.0)' },
  zuk:        { name: 'Żuk', role: 'runner', price: 300, brPrice: 300, talent: null, engine: 'front',
                accel: 0.55, top: 160, grip: 0.84, steer: 0.92, mass: 1500, armor: 0.85, downforce: 0.7,
                credit: 'Karol Miklas (CC BY 4.0)' },
  vaz2107:    { name: 'ВАЗ-2107', role: 'runner', price: 450, brPrice: 450, talent: null, ram: true, engine: 'front',
                accel: 0.62, top: 185, grip: 0.88, steer: 0.95, mass: 1060, armor: 0.8, downforce: 0.9,
                credit: 'Arkady Gribachev (CC BY 4.0)' },
  punto:      { name: 'Fiat Punto GT', role: 'runner', price: 700, brPrice: 700, talent: null, engine: 'front',
                accel: 0.75, top: 205, grip: 0.95, steer: 1.1, mass: 1000, armor: 1.15, downforce: 1.1,
                credit: 'Karol Miklas (CC BY 4.0)' },
  datsun:     { name: 'Datsun 240K GT', role: 'runner', price: 1000, brPrice: 1000, talent: null, engine: 'front',
                accel: 0.82, top: 220, grip: 0.96, steer: 1.0, mass: 1150, armor: 1.0, downforce: 1.3,
                credit: 'Karol Miklas (CC BY-SA 4.0)' },
  fulvia:     { name: 'Lancia Fulvia Rallye', role: 'runner', price: 1500, brPrice: 1300, talent: 'jump', engine: 'front',
                accel: 0.8, top: 210, grip: 1.12, steer: 1.15, mass: 950, armor: 0.95, downforce: 1.4,
                credit: 'Floppy (CC BY-NC 4.0)' },
  alfa33:     { name: 'Alfa Romeo 33 Stradale', role: 'runner', price: 2200, brPrice: 1700, talent: 'flip', flipper: true, engine: 'mid',
                accel: 0.95, top: 260, grip: 1.12, steer: 1.18, mass: 700, armor: 1.25, downforce: 2.8,
                credit: 'Ipatov Kirill (CC BY-NC 4.0)' },
  porsche930: { name: 'Porsche 911 Turbo (930)', role: 'runner', price: 3200, brPrice: 3200, talent: null, engine: 'rear',
                accel: 1.0, top: 270, grip: 1.08, steer: 1.14, mass: 1300, armor: 1.0, downforce: 3.2,
                credit: 'Lionsharp Studios (CC BY 4.0)' },
  charger:    { name: 'Dodge Charger (Fast & Furious 8)', role: 'runner', price: 4500, brPrice: 4500, talent: null, engine: 'front', pushBar: true,
                accel: 1.05, top: 280, grip: 1.06, steer: 1.12, mass: 1800, armor: 0.7, downforce: 1.8,
                credit: 'VTX (CC BY-NC-SA 4.0)' },
  // ------------------------------------------------ hunter
  police:     { name: 'Sci-Fi Police Car', role: 'hunter', price: 0, brPrice: 2000, talent: null, engine: 'front',
                accel: 0.85, top: 240, grip: 1.0, steer: 1.0, mass: 1700, armor: 0.9, downforce: 2.2,
                credit: 'SpatialNeglect (CC BY-NC-ND 4.0)' },
  gt3r:       { name: 'Porsche 911 GT3 R (992)', role: 'hunter', price: 1200, brPrice: 2600, talent: null, engine: 'rear', sideSpikes: true,
                accel: 1.1, top: 300, grip: 1.22, steer: 1.28, mass: 1300, armor: 1.1, downforce: 8,
                credit: 'Dave Love (CC BY 4.0)' },
  m3a1:       { name: 'M3A1 Scout Car', role: 'hunter', price: 2200, brPrice: 6500, talent: null, engine: 'front',
                accel: 0.74, top: 190, grip: 0.9, steer: 0.9, mass: 4000, armor: 0.55, downforce: 0.6,
                credit: 'Gerhald (CC BY 4.0)' },
  armored:    { name: 'Armored Car', role: 'hunter', price: 4000, brPrice: 9000, talent: null, engine: 'front',
                accel: 0.66, top: 175, grip: 0.86, steer: 0.85, mass: 7000, armor: 0.4, downforce: 0.6,
                credit: 'Fredrik (CC BY 4.0)' },
};

// equipment: pushBar — a steel bull bar in front (crashes with the front: the car takes much less, the other more;
// walls bend it); sideSpikes — spikes along both sides that burst the tyres they touch (blunter as the side caves in)
export const CAR_LIST = {
  runner: ['smallcar', 'zuk', 'vaz2107', 'punto', 'datsun', 'fulvia', 'alfa33', 'porsche930', 'charger'],
  hunter: ['police', 'gt3r', 'm3a1', 'armored'],
  // battle royale: everything, cheapest first
  solo: ['smallcar', 'zuk', 'vaz2107', 'punto', 'datsun', 'fulvia', 'alfa33', 'police', 'gt3r', 'porsche930', 'charger', 'm3a1', 'armored'],
};
export const START_CAR = { runner: 'smallcar', hunter: 'police', solo: 'smallcar' };
