import React, { useState } from 'react';
import { districtFullName } from '../../../lib/tenants.js';

export default function StepSchool({
  schoolsByDistrict,
  selectedSchoolId,
  onSelectSchool,
  childIndex,
}) {
  const [district, setDistrict] = useState('');

  const districts = Object.keys(schoolsByDistrict).sort((a, b) =>
    districtFullName(a).localeCompare(districtFullName(b)),
  );

  return (
    <div>
      <h1 className="font-titan text-3xl text-j2s-ink sm:text-4xl">
        {childIndex === 0 ? "Let's find your school" : `School for child ${childIndex + 1}`}
      </h1>
      <p className="mt-2 text-j2s-ink/70">
        Start by picking the district, then your school.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label-field">District</label>
          <select
            className="input-field"
            value={district}
            onChange={(e) => setDistrict(e.target.value)}
          >
            <option value="">Select a district&hellip;</option>
            {districts.map((d) => (
              <option key={d} value={d}>
                {districtFullName(d)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {district && (
        <div className="mt-8 animate-fade-in">
          <h2 className="font-titan text-xl text-j2s-ink">
            Schools in {districtFullName(district)}
          </h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(schoolsByDistrict[district] || []).map((s) => {
              const active = s.id === selectedSchoolId;
              return (
                <button
                  key={s.id}
                  onClick={() => onSelectSchool(s)}
                  className={`rounded-xl border-2 p-4 text-left transition ${
                    active
                      ? 'border-j2s-purple bg-j2s-purple-soft shadow-pop'
                      : 'border-j2s-purple/10 bg-white hover:border-j2s-purple/40 hover:bg-j2s-purple-soft/30'
                  }`}
                >
                  <p className="font-bold text-j2s-ink">{s.name}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
