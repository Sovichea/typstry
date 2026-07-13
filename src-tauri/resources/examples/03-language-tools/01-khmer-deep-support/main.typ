#import "@preview/cetz:0.3.3"

#set document(
  title: "បច្ចេកទេសរចនាតម្រងសកម្ម",
  author: "Typsastra Examples",
)

// typsastra:typography:start
#set text(font: "MiSans Latin", size: 11pt)
#set text(font: ("MiSans Latin", "MiSans Khmer"))
// typsastra:typography:end

#let draw-line = cetz.draw.line
#let draw-rect = cetz.draw.rect
#let draw-content = cetz.draw.content

#let draw-ground(x, y) = {
  draw-line((x, y), (x, y - 0.15))
  let gy = y - 0.15
  draw-line((x - 0.15, gy), (x + 0.15, gy))
  draw-line((x - 0.1, gy - 0.05), (x + 0.1, gy - 0.05))
  draw-line((x - 0.05, gy - 0.1), (x + 0.05, gy - 0.1))
}

#let draw-resistor(x1, y1, x2, y2, label) = {
  let (x1, y1, x2, y2) = if x1 == x2 {
    if y1 > y2 { (x2, y2, x1, y1) } else { (x1, y1, x2, y2) }
  } else {
    if x1 > x2 { (x2, y2, x1, y1) } else { (x1, y1, x2, y2) }
  }
  let mx = (x1 + x2) / 2
  let my = (y1 + y2) / 2
  if x1 == x2 {
    draw-line((x1, y1), (x1, my - 0.25))
    draw-rect((x1 - 0.1, my - 0.25), (x1 + 0.1, my + 0.25), fill: white)
    draw-content((x1 + 0.3, my), label)
    draw-line((x1, my + 0.25), (x2, y2))
  } else {
    draw-line((x1, y1), (mx - 0.25, y1))
    draw-rect((mx - 0.25, y1 - 0.1), (mx + 0.25, y1 + 0.1), fill: white)
    draw-content((mx, y1 + 0.25), label)
    draw-line((mx + 0.25, y1), (x2, y2))
  }
}

#let draw-capacitor(x1, y1, x2, y2, label) = {
  let (x1, y1, x2, y2) = if x1 == x2 {
    if y1 > y2 { (x2, y2, x1, y1) } else { (x1, y1, x2, y2) }
  } else {
    if x1 > x2 { (x2, y2, x1, y1) } else { (x1, y1, x2, y2) }
  }
  let mx = (x1 + x2) / 2
  let my = (y1 + y2) / 2
  if x1 == x2 {
    draw-line((x1, y1), (x1, my - 0.04))
    draw-line((x1 - 0.15, my - 0.04), (x1 + 0.15, my - 0.04), stroke: 1.2pt)
    draw-line((x1 - 0.15, my + 0.04), (x1 + 0.15, my + 0.04), stroke: 1.2pt)
    draw-line((x1, my + 0.04), (x2, y2))
    draw-content((x1 + 0.35, my), label)
  } else {
    draw-line((x1, y1), (mx - 0.04, y1))
    draw-line((mx - 0.04, y1 - 0.15), (mx - 0.04, y1 + 0.15), stroke: 1.2pt)
    draw-line((mx + 0.04, y1 - 0.15), (mx + 0.04, y1 + 0.15), stroke: 1.2pt)
    draw-line((mx + 0.04, y1), (x2, y2))
    draw-content((mx, y1 + 0.3), label)
  }
}

#set figure(supplement: [រូបភាព])
#set par(spacing: 1em, leading: 1em)
#set block(spacing: 1em)

#show heading: set text(fill: rgb("#1d3557"))
#show heading: set block(spacing: 1em)

= ជំពូកទី ១៦៖ បច្ចេកទេសរចនាតម្រងសកម្ម

== ១៦.៣.១ តម្រងឆ្លងទាបលំដាប់ទីមួយ

រូប @fig-noninverting និងរូប @fig-inverting បង្ហាញតម្រងឆ្លងទាបលំដាប់ទីមួយពីរទម្រង់៖ #strong[ទម្រង់មិនច្រាស (noninverting)] និង #strong[ទម្រង់ច្រាស (inverting)]។

#grid(
  columns: (1fr, 1fr),
  gutter: 20pt,
  align: center,
  [#figure(
    cetz.canvas(length: 1.2cm, {
      // Op-amp triangle
      draw-line((0, -0.6), (0, 0.6), (1.2, 0), close: true)
      draw-content((0.2, 0.25), text(size: 9pt)[$+$])
      draw-content((0.2, -0.25), text(size: 9pt)[$-$])

      // Output
      draw-line((1.2, 0), (2.0, 0))
      draw-content((2.05, 0), [$V_("OUT")$], anchor: "west")

      // Feedback loop
      draw-line((1.6, 0), (1.6, -0.8))
      draw-resistor(1.6, -0.8, -0.4, -0.8, [$R_2$])
      draw-line((-0.4, -0.8), (-0.4, -0.3))
      draw-line((-0.4, -0.3), (0, -0.3))

      // R3 to ground
      draw-resistor(-0.4, -0.8, -0.4, -1.6, [$R_3$])
      draw-ground(-0.4, -1.6)

      // Noninverting input path (+)
      draw-line((0, 0.3), (-0.6, 0.3))
      draw-capacitor(-0.6, 0.3, -0.6, -0.5, [$C_1$])
      draw-ground(-0.6, -0.5)

      draw-resistor(-1.8, 0.3, -0.6, 0.3, [$R_1$])
      draw-line((-1.8, 0.3), (-2.2, 0.3))
      draw-content((-2.25, 0.3), [$V_("IN")$], anchor: "east")
    }),
    caption: [តម្រងឆ្លងទាបលំដាប់ទីមួយក្នុងទម្រង់មិនច្រាស],
  ) <fig-noninverting>],
  [#figure(
    cetz.canvas(length: 1.2cm, {
      // Op-amp triangle
      draw-line((0, -0.6), (0, 0.6), (1.2, 0), close: true)
      draw-content((0.2, 0.25), text(size: 9pt)[$-$])
      draw-content((0.2, -0.25), text(size: 9pt)[$+$])

      // Output
      draw-line((1.2, 0), (2.0, 0))
      draw-content((2.05, 0), [$V_("OUT")$], anchor: "west")

      // Feedback loops (main vertical lines)
      draw-line((1.6, 0), (1.6, 1.6))
      draw-line((-0.4, 0.3), (-0.4, 1.6))

      // R2 branch
      draw-resistor(-0.4, 0.8, 1.6, 0.8, [$R_2$])

      // C1 branch
      draw-capacitor(-0.4, 1.6, 1.6, 1.6, [$C_1$])

      // Inverting input connection
      draw-line((-0.4, 0.3), (0, 0.3))

      // Input resistor R1
      draw-resistor(-1.6, 0.3, -0.4, 0.3, [$R_1$])
      draw-line((-1.6, 0.3), (-2.0, 0.3))
      draw-content((-2.05, 0.3), [$V_("IN")$], anchor: "east")

      // Noninverting input to ground (+)
      draw-line((0, -0.3), (-0.3, -0.3))
      draw-ground(-0.3, -0.3)
    }),
    caption: [តម្រងឆ្លងទាបលំដាប់ទីមួយក្នុងទម្រង់ច្រាស],
  ) <fig-inverting>],
)

#strong[អនុគមន៍បញ្ជូន (transfer function)] របស់សៀគ្វីទាំងពីរត្រូវបានកំណត់ដូចខាងក្រោម៖

$
  A(s) = (1 + R_2 / R_3) / (1 + omega_c R_1 C_1 s) quad "និង" quad A(s) = - (R_2 / R_1) / (1 + omega_c R_2 C_1 s)
$

សញ្ញាដក ($-$) បញ្ជាក់ថា #strong[អំព្លីច្រាស] បង្កើតបម្រែបម្រួលផាស $180$ ដឺក្រេ រវាងច្រកចូល និងច្រកចេញរបស់តម្រង។

ការប្រៀបធៀបមេគុណរវាងអនុគមន៍បញ្ជូនទាំងពីរ និងសមីការស្តង់ដារ ផ្តល់លទ្ធផល៖

$ A_0 = 1 + R_2 / R_3 quad "និង" quad A_0 = - R_2 / R_1 $
$ a_1 = omega_c R_1 C_1 quad "និង" quad a_1 = omega_c R_2 C_1 $

ដើម្បីជ្រើសតម្លៃគ្រឿងបង្គុំ យើងកំណត់ប្រេកង់កាត់ ($f_c$) កម្រិតពង្រីក DC ($A_0$) និងកាប៉ាស៊ីទ័រ ($C_1$) ជាមុន រួចគណនារ៉េស៊ីស្តង់ ($R_1$ និង $R_2$)៖

$ R_1 = a_1 / (2 pi f_c C_1) quad "និង" quad R_2 = a_1 / (2 pi f_c C_1) $
$ R_2 = R_3 (A_0 - 1) quad "និង" quad R_1 = R_2 / A_0 $

មេគុណ $a_1$ អាចយកពីតារាងមេគុណ ដូចជា តារាងទី ១៦.៦ ដល់ ១៦.១២ ក្នុងផ្នែក ១៦.៩។

#block(
  fill: rgb("#f1faee"),
  inset: 12pt,
  radius: 4pt,
  stroke: rgb("#a8dadc"),
  [
    #set text(size: 10pt)
    #strong[ចំណាំ៖] តម្រងលំដាប់ទីមួយគ្រប់ប្រភេទមានមេគុណ $a_1 = 1$។ ចំពោះតម្រងលំដាប់ខ្ពស់ តម្លៃ $a_1 != 1$ ព្រោះប្រេកង់កាត់របស់ថ្នាក់លំដាប់ទីមួយនីមួយៗខុសពីប្រេកង់កាត់របស់តម្រងសរុប។
  ],
)

=== ឧទាហរណ៍ទី ១៦.១៖ តម្រងឆ្លងទាបលំដាប់ទីមួយដែលមានកម្រិតពង្រីកស្មើមួយ

គណនាតម្លៃគ្រឿងបង្គុំសម្រាប់តម្រងឆ្លងទាបលំដាប់ទីមួយដែលមាន $f_c = 1 "kHz"$ និង $C_1 = 47 "nF"$៖

តម្លៃ $R_1$ ត្រូវបានគណនាដូចខាងក្រោម៖
$ R_1 = a_1 / (2 pi f_c C_1) = 1 / (2 pi times 10^3 "Hz" times 47 times 10^(-9) "F") = 3.38 "k"Omega $

បើសៀគ្វីនេះជាថ្នាក់ទីមួយរបស់តម្រង Bessel លំដាប់ទីបី ហើយប្រើ $f_c$ និង $C_1$ ដដែល នោះតម្លៃ $R_1$ នឹងប្រែប្រួល។ ពីតារាងទី ១៦.៦ យើងបាន $a_1 = 0.756$៖

$ R_1 = a_1 / (2 pi f_c C_1) = 0.756 / (2 pi times 10^3 "Hz" times 47 times 10^(-9) "F") = 2.56 "k"Omega $

នៅកម្រិតពង្រីកស្មើមួយ អំព្លីមិនច្រាសដំណើរការជា #strong[វ៉ុលតាម (voltage follower)] ដែលផ្តល់ភាពសុក្រឹតខ្ពស់។ ចំពោះអំព្លីច្រាស ភាពសុក្រឹតនៃកម្រិតពង្រីកអាស្រ័យលើកម្រិតលម្អៀងរបស់រ៉េស៊ីស្តង់ $R_1$ និង $R_2$។

#align(center, figure(
  cetz.canvas(length: 1.2cm, {
    // Op-amp triangle
    draw-line((0, -0.6), (0, 0.6), (1.2, 0), close: true)
    draw-content((0.2, 0.25), text(size: 9pt)[$+$])
    draw-content((0.2, -0.25), text(size: 9pt)[$-$])

    // Output
    draw-line((1.2, 0), (2.0, 0))
    draw-content((2.05, 0), [$V_("OUT")$], anchor: "west")

    // Direct feedback loop (Voltage Follower)
    draw-line((1.6, 0), (1.6, -0.7))
    draw-line((1.6, -0.7), (-0.4, -0.7))
    draw-line((-0.4, -0.7), (-0.4, -0.3))
    draw-line((-0.4, -0.3), (0, -0.3))

    // Noninverting input path (+)
    draw-line((0, 0.3), (-0.6, 0.3))
    draw-capacitor(-0.6, 0.3, -0.6, -0.5, [$C_1$])
    draw-ground(-0.6, -0.5)

    draw-resistor(-1.8, 0.3, -0.6, 0.3, [$R_1$])
    draw-line((-1.8, 0.3), (-2.2, 0.3))
    draw-content((-2.25, 0.3), [$V_("IN")$], anchor: "east")
  }),
  caption: [តម្រងឆ្លងទាបមិនច្រាសដែលមានកម្រិតពង្រីកស្មើមួយ],
))

== ការគណនា និងគូសក្រាបដោយ MATLAB
កូដខាងក្រោមគណនាតម្លៃគ្រឿងបង្គុំ ហើយគូសក្រាបរេស្ប៉ុងប្រេកង់ទាំងទំហំ និងផាស សម្រាប់ឧទាហរណ៍ខាងលើ៖

```matlab
% MATLAB script to design First-Order Low-Pass Filters
clear; clc; close all;

% Given parameters
fc = 1e3;          % Corner frequency: 1 kHz
C1 = 47e-9;        % Capacitor: 47 nF

% Case 1: First-order Unity-gain Low-pass Filter (a1 = 1)
a1_case1 = 1.0;
R1_case1 = a1_case1 / (2 * pi * fc * C1);
fprintf('Case 1 (First-order LP, a1 = 1):\n');
fprintf('  R1 = %.2f kOhm\n\n', R1_case1 / 1e3);

% Case 2: First stage of 3rd-order Bessel Low-pass Filter (a1 = 0.756)
a1_case2 = 0.756;
R1_case2 = a1_case2 / (2 * pi * fc * C1);
fprintf('Case 2 (First stage of 3rd-order Bessel, a1 = 0.756):\n');
fprintf('  R1 = %.2f kOhm\n\n', R1_case2 / 1e3);

% Frequency analysis using Transfer Functions
f = logspace(1, 5, 1000); % Frequency vector from 10 Hz to 100 kHz
w = 2 * pi * f;
s = 1i * w;

% H(s) = 1 / (1 + a1 * (s / wc)) where wc = 2*pi*fc
wc = 2 * pi * fc;
H1 = 1 ./ (1 + a1_case1 * (s / wc));
H2 = 1 ./ (1 + a1_case2 * (s / wc));

% Plot Magnitude Response
figure;
subplot(2,1,1);
semilogx(f, 20*log10(abs(H1)), 'b-', 'LineWidth', 2); hold on;
semilogx(f, 20*log10(abs(H2)), 'r--', 'LineWidth', 2);
grid on;
title('Frequency Response of First-Order Low-Pass Stage');
ylabel('Magnitude (dB)');
legend('a_1 = 1.0 (First-order)', 'a_1 = 0.756 (Bessel 1st Stage)');
axis([10 1e5 -30 5]);

% Plot Phase Response
subplot(2,1,2);
semilogx(f, angle(H1)*180/pi, 'b-', 'LineWidth', 2); hold on;
semilogx(f, angle(H2)*180/pi, 'r--', 'LineWidth', 2);
grid on;
xlabel('Frequency (Hz)');
ylabel('Phase (degrees)');
legend('a_1 = 1.0 (First-order)', 'a_1 = 0.756 (Bessel 1st Stage)');
axis([10 1e5 -90 0]);
```
