package collaboration

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestExpiredWebMediaLeaseCannotPublish(t *testing.T) {
	pool := integrationPool(t)
	actor, _ := seedNative(t, pool, "media-lease-owner")
	project := seedProject(t, pool, map[string]Role{actor: Owner})
	ctx := t.Context()
	var version string
	err := pool.QueryRow(ctx, `WITH item AS (
 INSERT INTO web_media_items(project_id,title) VALUES ($1,'Mix') RETURNING id
 ), upload AS (
 INSERT INTO web_uploads(project_id,item_id,actor_id,filename,bytes,kind)
 SELECT $1,id,$2,'mix.wav',100,'wav' FROM item RETURNING id,item_id
 ), version AS (
 INSERT INTO web_media_versions(id,project_id,item_id,filename,description)
 SELECT id,$1,item_id,'mix.wav','' FROM upload RETURNING id
 )
 INSERT INTO web_media_jobs(version_id) SELECT id FROM version RETURNING version_id::text`, project, actor).Scan(&version)
	if err != nil {
		t.Fatal(err)
	}

	worker := webMediaWorker{pool: pool}
	first, err := worker.claim(ctx)
	if err != nil || first.version != version || first.attempt != 1 {
		t.Fatalf("first claim = %+v, %v", first, err)
	}
	if _, err := worker.claim(ctx); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a live lease was reclaimed: %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE web_media_jobs SET leased_until=now()-interval '1 second' WHERE version_id=$1", version); err != nil {
		t.Fatal(err)
	}
	second, err := worker.claim(ctx)
	if err != nil || second.version != version || second.lease == first.lease || second.attempt != 2 {
		t.Fatalf("expired lease was not replaced: %+v, %v", second, err)
	}
	if err := worker.finish(ctx, first, 1000, [3]webArtifact{}); !errors.Is(err, errStaleMediaLease) {
		t.Fatalf("stale lease accepted: %v", err)
	}
	var state string
	if err := pool.QueryRow(ctx, "SELECT state FROM web_media_versions WHERE id=$1", version).Scan(&state); err != nil || state != "processing" {
		t.Fatalf("stale worker changed media state: %s, %v", state, err)
	}
}
