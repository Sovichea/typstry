import "./style.css";
import { TypsastraWorkspaceController } from "./appController";
import { initializeLucideIcons } from "./ui/icons";

document.addEventListener("DOMContentLoaded", () => {
  initializeLucideIcons();
  void new TypsastraWorkspaceController().bootstrap();
});
