import "./style.css";
import { TypstellaWorkspaceController } from "./appController";
import { initializeLucideIcons } from "./ui/icons";

document.addEventListener("DOMContentLoaded", () => {
  initializeLucideIcons();
  void new TypstellaWorkspaceController().bootstrap();
});
