import { SpeedBand } from "./SpeedBand";
import { Heatmap } from "./Heatmap";

export function XView() {
  return (
    <div className="xview">
      <SpeedBand />
      <Heatmap />
    </div>
  );
}
