import { buildCityModel } from "../lib/city-model";
const g = JSON.parse(require("fs").readFileSync(".probe/g.json","utf8"));
const m = buildCityModel(g)!;
const kinds: Record<string, number> = {};
for (const p of m.scenery) kinds[p.kind] = (kinds[p.kind]??0)+1;
console.log("scenery", m.scenery.length, kinds);
let onRoad = 0, inPlot = 0;
for (const p of m.scenery) {
  for (const a of m.assets) {
    if (Math.abs(p.position.x-a.position.x) < a.footprint.plot/2 && Math.abs(p.position.z-a.position.z) < a.footprint.plot/2) inPlot++;
  }
  for (const s of m.grid.segments) {
    const h = Math.abs(s.z2-s.z1) < 0.001;
    const across = h ? Math.abs(p.position.z - s.z1) : Math.abs(p.position.x - s.x1);
    if (across < s.width/2) onRoad++;
  }
}
console.log("in plot:", inPlot, "on road:", onRoad);
console.log("pavements", m.pavements.length, "parking", m.parking.length);
