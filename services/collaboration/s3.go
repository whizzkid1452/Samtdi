package collaboration

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

var errBlobMissing = errors.New("object storage key is missing")

type S3Config struct {
	Bucket   string
	Region   string
	Endpoint string
}

type BlobMetadata struct {
	Size   int64
	SHA256 string
}

type BlobStore interface {
	Put(ctx context.Context, key string, metadata BlobMetadata, content io.ReadSeeker) error
	Head(ctx context.Context, key string) (BlobMetadata, error)
	Open(ctx context.Context, key string) (io.ReadCloser, BlobMetadata, error)
	OpenRange(ctx context.Context, key string, first, last int64) (io.ReadCloser, BlobMetadata, error)
}

type s3Store struct {
	client *s3.Client
	bucket string
}

func newS3Store(ctx context.Context, settings S3Config, allowLoopbackHTTP bool) (BlobStore, error) {
	if settings.Bucket == "" || settings.Region == "" {
		return nil, errors.New("object storage bucket and region are required")
	}
	if settings.Endpoint != "" {
		endpoint, err := url.Parse(settings.Endpoint)
		if err != nil || !validEndpoint(endpoint, allowLoopbackHTTP) || endpoint.Path != "" || endpoint.ForceQuery {
			return nil, errors.New("invalid object storage endpoint")
		}
	}

	client := &http.Client{Timeout: 20 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	awsConfig, err := config.LoadDefaultConfig(ctx, config.WithRegion(settings.Region), config.WithHTTPClient(client))
	if err != nil {
		return nil, errors.New("object storage credential configuration failed")
	}

	store := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		if settings.Endpoint != "" {
			options.BaseEndpoint = aws.String(settings.Endpoint)
			options.UsePathStyle = true
		}
	})

	return &s3Store{client: store, bucket: settings.Bucket}, nil
}

func (store *s3Store) Put(ctx context.Context, key string, metadata BlobMetadata, content io.ReadSeeker) error {
	digest, err := hex.DecodeString(metadata.SHA256)
	if err != nil || len(digest) != 32 {
		return errors.New("invalid blob checksum")
	}

	_, err = store.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &store.bucket, Key: &key, Body: content, ContentLength: &metadata.Size,
		ContentType: aws.String("application/octet-stream"), ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(digest)),
		Metadata: map[string]string{"sha256": metadata.SHA256},
	})
	return err
}

func (store *s3Store) Head(ctx context.Context, key string) (BlobMetadata, error) {
	result, err := store.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &store.bucket, Key: &key})
	if err != nil {
		return BlobMetadata{}, objectStorageError(err)
	}
	if result.ContentLength == nil {
		return BlobMetadata{}, errors.New("object storage size is missing")
	}

	return BlobMetadata{Size: *result.ContentLength, SHA256: result.Metadata["sha256"]}, nil
}

func (store *s3Store) Open(ctx context.Context, key string) (io.ReadCloser, BlobMetadata, error) {
	result, err := store.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &store.bucket, Key: &key, ChecksumMode: types.ChecksumModeEnabled})
	if err != nil {
		return nil, BlobMetadata{}, objectStorageError(err)
	}
	if result.ContentLength == nil {
		result.Body.Close()
		return nil, BlobMetadata{}, errors.New("object storage size is missing")
	}

	return result.Body, BlobMetadata{Size: *result.ContentLength, SHA256: result.Metadata["sha256"]}, nil
}

func (store *s3Store) OpenRange(ctx context.Context, key string, first, last int64) (io.ReadCloser, BlobMetadata, error) {
	requested := fmt.Sprintf("bytes=%d-%d", first, last)
	result, err := store.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &store.bucket, Key: &key, Range: &requested})
	if err != nil {
		return nil, BlobMetadata{}, objectStorageError(err)
	}

	var begin, end, total int64
	read, err := fmt.Sscanf(aws.ToString(result.ContentRange), "bytes %d-%d/%d", &begin, &end, &total)
	if err != nil || read != 3 || begin != first || end != last || total <= last ||
		aws.ToInt64(result.ContentLength) != last-first+1 {
		result.Body.Close()
		return nil, BlobMetadata{}, errors.New("invalid object storage byte range")
	}

	return result.Body, BlobMetadata{Size: total, SHA256: result.Metadata["sha256"]}, nil
}

func objectStorageError(err error) error {
	var api smithy.APIError
	if errors.As(err, &api) && (api.ErrorCode() == "NotFound" || api.ErrorCode() == "NoSuchKey") {
		return errBlobMissing
	}

	return err
}

func (store *s3Store) ping(ctx context.Context) error {
	_, err := store.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &store.bucket})
	return err
}
