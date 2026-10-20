import { boxesOverlap } from './faces.service';

const box = (boxX: number, boxY: number, boxWidth = 100, boxHeight = 100) => ({
  boxX,
  boxY,
  boxWidth,
  boxHeight,
});

describe('boxesOverlap', () => {
  it('matches the same face detected slightly shifted', () => {
    expect(boxesOverlap(box(100, 100), box(110, 105, 95, 98))).toBe(true);
  });

  it('keeps separate faces apart', () => {
    expect(boxesOverlap(box(100, 100), box(180, 100))).toBe(false);
    expect(boxesOverlap(box(0, 0), box(300, 300))).toBe(false);
  });
});
