import "./style.css";
import { TypstryWorkspaceController } from "./appController";

document.addEventListener("DOMContentLoaded", () => {
  void new TypstryWorkspaceController().bootstrap();
});
