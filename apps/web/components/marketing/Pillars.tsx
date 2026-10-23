import Image from 'next/image';
import { pillars } from '../../content/marketing';

export function Pillars() {
  return (
    <section className="block" id="how" aria-labelledby="how-title">
      <div className="wrap">
        <div className="head">
          <h2 id="how-title">
            {pillars.titleLead}
            <br />
            <span className="grad">{pillars.titleAccent}</span>
          </h2>
        </div>
        <div className="pillars">
          {pillars.items.map((p) => (
            <div className="pillar" key={p.id}>
              <Image
                className="pillar-img"
                src={p.src}
                alt=""
                width={p.width}
                height={p.height}
                sizes="(max-width: 900px) 152px, 190px"
              />
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </div>
          ))}
        </div>
        <div className="how-cta">
          <a href={pillars.cta.href} className="btn btn-mint">
            {pillars.cta.label}
          </a>
        </div>
      </div>
    </section>
  );
}
