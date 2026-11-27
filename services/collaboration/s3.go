package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
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
	client   *s3.Client
	bucket   string
	supabase bool
}

const supabaseObjectLimit int64 = 45_000_000

func isSupabaseS3Endpoint(endpoint *url.URL) bool {
	return endpoint.Scheme == "https" && strings.HasSuffix(endpoint.Hostname(), ".storage.supabase.co") &&
		endpoint.Path == "/storage/v1/s3" && endpoint.Port() == ""
}

func (store *s3Store) objectLimit() int64 {
	if store.supabase {
		return supabaseObjectLimit
	}
	return webUploadLimit
}

func newS3Store(ctx context.Context, settings S3Config, allowLoopbackHTTP bool) (BlobStore, error) {
	if settings.Bucket == "" || settings.Region == "" {
		return nil, errors.New("object storage bucket and region are required")
	}
	supabase := false
	if settings.Endpoint != "" {
		endpoint, err := url.Parse(settings.Endpoint)
		if err != nil || !validEndpoint(endpoint, allowLoopbackHTTP) || (endpoint.Path != "" && !isSupabaseS3Endpoint(endpoint)) || endpoint.ForceQuery {
			return nil, errors.New("invalid object storage endpoint")
		}
		supabase = isSupabaseS3Endpoint(endpoint)
	}

	client := &http.Client{Timeout: 20 * time.Minute, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	awsConfig, err := config.LoadDefaultConfig(ctx, config.WithRegion(settings.Region), config.WithHTTPClient(client))
	if err != nil {
		return nil, errors.New("object storage credential configuration failed")
	}

	if supabase {
		// Supabase does not implement the full AWS checksum API. Verify every
		// stored artifact by reading its bytes back instead of trusting metadata.
		awsConfig.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		awsConfig.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	}

	store := s3.NewFromConfig(awsConfig, func(options *s3.Options) {
		if settings.Endpoint != "" {
			options.BaseEndpoint = aws.String(settings.Endpoint)
			options.UsePathStyle = true
		}
	})

	return &s3Store{client: store, bucket: settings.Bucket, supabase: supabase}, nil
}

func (store *s3Store) Put(ctx context.Context, key string, metadata BlobMetadata, content io.ReadSeeker) error {
	digest, err := hex.DecodeString(metadata.SHA256)
	if err != nil || len(digest) != 32 {
		return errors.New("invalid blob checksum")
	}

	input := &s3.PutObjectInput{
		Bucket: &store.bucket, Key: &key, Body: content, ContentLength: &metadata.Size,
		ContentType: aws.String("application/octet-stream"),
		Metadata: map[string]string{"sha256": metadata.SHA256},
	}
	if !store.supabase {
		input.ChecksumSHA256 = aws.String(base64.StdEncoding.EncodeToString(digest))
	} else if metadata.Size < 1 || metadata.Size > store.objectLimit() {
		return errors.New("object exceeds free storage size limit")
	}
	if _, err := store.client.PutObject(ctx, input); err != nil {
		return err
	}
	if !store.supabase {
		return nil
	}
	body, actual, err := store.Open(ctx, key)
	if err != nil {
		return err
	}
	defer body.Close()
	if actual != metadata {
		return errors.New("object storage metadata mismatch")
	}
	return verifyBlobChecksum(body, metadata)
}

func verifyBlobChecksum(body io.Reader, metadata BlobMetadata) error {
	digest := sha256.New()
	size, err := io.Copy(digest, io.LimitReader(body, metadata.Size+1))
	if err != nil {
		return err
	}
	if size != metadata.Size || hex.EncodeToString(digest.Sum(nil)) != metadata.SHA256 {
		return errors.New("object storage checksum mismatch")
	}
	return nil
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
	input := &s3.GetObjectInput{Bucket: &store.bucket, Key: &key}
	if !store.supabase {
		input.ChecksumMode = types.ChecksumModeEnabled
	}
	result, err := store.client.GetObject(ctx, input)
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
