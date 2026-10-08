import { IN } from './constants.js';
import { Arm6328 } from './mechanisms/mech6328.js';

// Robot profiles: chassis + drivetrain numbers and the mechanism that goes on top.
export const ROBOTS = {
  dja: {
    id: 'dja',
    name: 'Double-jointed arm (9999)',
    team: 9999,
    frame: 25 * IN, // small square frame perimeter
    bumper: 3.25 * IN,
    bumperBottom: 1.0 * IN,
    bumperTop: 6.0 * IN,
    mass: 56,
    maxSpeed: 4.42, // SDS MK4i L2 + NEO: 14.5 ft/s
    maxAccel: 8.5,
    maxOmega: 12.4, // maxLinearSpeed / drive base radius
    maxAlpha: 32,
    moduleOffset: (19.75 * IN) / 2, // trackwidth 19.75 in
    bellyColor: 0x8a8f96,
    mechanism: (r) => new Arm6328(r),
  },
};
