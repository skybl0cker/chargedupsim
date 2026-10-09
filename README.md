# Charged Up Sim — FRC 2023

A browser-based 3D simulator of the 2023 FIRST Robotics Competition game **Charged Up**.
It uses three.js for rendering and the Rapier physics engine (WASM). It has no build step and no internet dependency, because both libraries are vendored in `vendor/`.

## Run

```bash
./run.sh            # then open http://localhost:8023
```

(Any static server works. Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.)

## What's simulated

**Field.** Built from the 2023 Game Manual §5 (Arena) and its figures, with positions cross-checked against Team 6328's `FieldConstants`. The field is mirrored for red, not rotated.
- **Carpet & tape:** dark "Medallion" carpet, alliance-colored community and loading-zone lines, a white center line, 4 in black staging crosses, and white starting lines behind the walls.
- **Grids:** three assemblies (6 ft 3 in, 5 ft 6 in, 6 ft 3 in) on an aluminum frame. Hybrid nodes are 16 in deep with 5 in dividers. Cone nodes are 1.66 in aluminum pipes (34 in / 46 in) with plugs and reflective tape, rising through the 35° textured slope (alliance-colored on the outer grids, black on co-op), with polycarbonate fins between them. Cube nodes are clear polycarbonate shelves with 3 in walls (the top-row rear wall is angled). Scored cones sit high on the pole.
- **Charge stations:** a 4 × 8 ft frame hinged at its 9⅛ in top surface. It self-centers to level, travels ±15°, and has hinge friction. The polycarbonate ramps pivot and slide (about 34° when level, 11° / 71° fully tilted). Alliance-colored LEVEL lights and the logo decal are on top.
- **Other elements:**
  - Clear 12¼ in barriers on 16 in bases.
  - ⅞ in cable protectors running to each charge station's center.
  - Double substations with pipe grates, a 45° ramp, a window, a portal, and black sliding shelves at 37⅜ in.
  - Wire-panel single substations with tilted chutes.
  - Driver stations: diamond-plate base, window, team signs, and LED strings that fill as you score links.
- **AprilTags:** real 16h5 tags (IDs 1–8) at the official heights.

**Game pieces.** Pieces are rigid bodies. Cones (12.8 in, 1 lb 7 oz, convex hull with a square base) can tip over. Cubes are 9.5 in rounded cubes.

**Robots.** Pick one on the home screen.
- **2910 Jack in the Bot — Phantom (2023), the default:** built from Team 2910's public robot code, CAD render and reveal.
  - **Chassis:** 26 × 28 in frame (22.75 × 20.75 in module layout) on SDS MK4i L3 swerve.
  - **Arm:** a pivoting 2-stage cascade telescoping arm (22.75–53 in) with a wrist and roller intake. It uses their exact pivot location, tube offset, joint limits and motion speeds, and retracts before big shoulder swings like their code.
  - **Poses:** every scoring and pickup position is their real shoulder / extension / wrist value from `ArmPoseConstants.java`. That means scoring mid and high over the **back**, the low row out the **front**, and both cubes and cones (standing or tipped over) off the floor in **front**, and double-substation cones over the back and cubes from the front.
- **9999 Double-jointed arm:** arm geometry based on FRC 6328's public 2023 code. In cube mode the front cube intake deploys and the arm waits at it for the handoff; in cone mode the arm picks cones up off the floor behind the robot.

**Arcade handling.**
- **Arm:** moves smoothly and directly between presets and doesn't collide with the field. The cube intake swings out of the way when the arm comes down on its side.
- **Scoring:** release a piece while it's lined up over a node (the status panel shows **✓ RELEASE TO SCORE**) and it slides straight into place. Pieces never get knocked loose.

**Fouls (2023 manual §7).** Each foul credits the other alliance 5 points (tech foul: 12).
- **G106:** taller than 6 ft 6 in.
- **G107:** more than 48 in past the frame for over 3 s (tech foul if it scores).
- **G108:** extended in the opponent's community or loading zone.
- **G302:** crossing the center line in auto.
- **G304:** moving the opponent's charge station.
- **G401:** knocking a piece out of the field.
- **G403:** controlling more than one piece outside your zones.
- **G404:** launching outside your community (tech foul).

**Scoreboard and branding.** The official CHARGED UP and *FIRST* ENERGIZE logos, taken from the 2023 Game Manual, appear on the menu, the scoreboard, the charge station decals and the arena screens. The scoreboard is laid out like the 2023 broadcast real-time scoring bar: match name, a seconds countdown with the auto/teleop icon, scores, team numbers, link progress (n / 5, or n / 4 with coopertition), the coopertition handshake and the auto charge-station battery.

**Rules and scoring.**
- **Points:** auto and teleop piece values, links, supercharged nodes, mobility, auto dock/engage (one robot only), and endgame park/dock/engage.
- **Bonuses:** coopertition (lowers the sustainability threshold to 4 links), sustainability RP, activation RP (≥ 26 charge station points), and win/tie RP.
- **Timing:** charge station states are assessed after the period ends, the way the real field does it. The match timeline is 15 s auto, a 3 s pause, then 2:15 teleop with a 30 s endgame.

**Human players.** HPs stock the double substation with whatever piece your LEDs request (they swap it if you change your mind). They drop pieces down the single substation chute when you're lined up with your intake running.

**Single robot.** You're the only robot on the field. During autonomous, the AI code drives your robot through the routine you pick: score the preload high, over the charge station and back to engage, two-piece, and so on. It plans paths with A* and auto-balances.

## Controls

Everything can be remapped from **Controls** in the main or pause menu, and your bindings are saved in the browser. The keyboard starts on the layout below. The gamepad starts unbound: click a gamepad box, then press a button or push a stick direction to set it up.

| Default key | Action |
| --- | --- |
| W A S D | Drive (swerve, relative to the camera) |
| J / L | Turn |
| Shift (hold) | Intake — with no piece the arm drops to the floor automatically |
| K | Score / release |
| P | Holding a piece: high node · No piece: substation shelf + intake (press again to cancel) |
| O / I | Mid / low (hybrid) node |
| Space | Flip the third-person camera front ⇄ back |
| E | Switch cone / cube mode (only that piece can be intaken; LEDs signal your human player) |
| B (hold) | Auto-balance |
| C | Other camera views |
| H / Esc | Help / pause |

Pick your starting position (station 1, 2 or 3) on the main menu. The preload matches the node in front of you (cube in the center, cones on the sides).

The arm stows itself after a pickup or a score. The default camera follows the robot's position but not its rotation. Cone poles need roughly ±8.5 cm accuracy, just like the real thing.

## Known simplifications

- The arm is visual only: it doesn't collide with field elements. A piece scores if it's lined up over a node when you release it.
- Cones are always held upright, so there's no tipped-cone handling.
- Fouls are detected automatically for a solo robot; rules that need opponents (pinning, G209 contact, etc.) aren't modeled.

## Credits

This is an unofficial fan project and isn't affiliated with or endorsed by *FIRST*.

- ***FIRST*® Robotics Competition:** CHARGED UP℠, *FIRST*® ENERGIZE℠, and their logos are trademarks of *FIRST*. Field dimensions, rules, and scoring come from the [2023 FRC Game Manual](https://www.firstinspires.org/robotics/frc/game-and-season). The logos in `assets/` are taken from that manual.
- **Team 254, The Cheesy Poofs:** the match sounds in `assets/audio/` (start, end-of-auto/match buzzer, teleop start, endgame warning) come from [Cheesy Arena](https://github.com/Team254/cheesy-arena), their open-source field management system.
- **Team 6328, Mechanical Advantage:** field element positions were cross-checked against `FieldConstants` from their [RobotCode2023](https://github.com/Mechanical-Advantage/RobotCode2023). The team 9999 robot's double-jointed arm geometry, joint limits, inverse kinematics, and cube intake are based on that code (`arm_config.json`, `ArmKinematics.java`, `ArmPose.java`, `CubeIntake.java`) and their 2023 Open Alliance build thread.
- **Team 2910, Jack in the Bot:** the 2910 robot's dimensions, arm geometry, limits, speeds and every arm pose come from their [2023CompetitionRobot-Public](https://github.com/FRCTeam2910/2023CompetitionRobot-Public) code (`ArmSubsystem.java`, `ArmPoseConstants.java`, `ArmIOFalcon500.java`, `DrivetrainSubsystem.java`), and its look from their 2023 CAD release and robot reveal.
- **Libraries:** [three.js](https://threejs.org) (MIT) for 3D rendering and [Rapier](https://rapier.rs) (Apache 2.0) for physics.
