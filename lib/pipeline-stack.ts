import {
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import {
  AllowedMethods,
  CachedMethods,
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginAccessIdentity,
  PriceClass,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3Origin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  BuildSpec,
  LinuxBuildImage,
  PipelineProject,
} from "aws-cdk-lib/aws-codebuild";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  GitHubSourceAction,
  GitHubTrigger,
  S3DeployAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import {
  CanonicalUserPrincipal,
  Effect,
  PolicyStatement,
} from "aws-cdk-lib/aws-iam";
import { Bucket, BucketAccessControl } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as dotenv from "dotenv";

dotenv.config();

export class PlanningPokerAppStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const sourceOutput = new Artifact();
    const sourceAction = new GitHubSourceAction({
      actionName: "PlanningPokerAppGitHubAction",
      output: sourceOutput,
      repo: process.env.SOURCE_ACTION_REPO || "",
      owner: process.env.SOURCE_ACTION_OWNER || "",
      branch: "main",
      trigger: GitHubTrigger.POLL,
      oauthToken: SecretValue.secretsManager(
        process.env.SECRETS_MANAGER_ID || "",
        { jsonField: "token" }
      ),
    });

    const buildProject = new PipelineProject(
      this,
      "PlanningPokerAppBuildProject",
      {
        projectName: "PlanningPokerAppBuildProject",
        buildSpec: BuildSpec.fromSourceFilename("buildspec.yml"),
        environment: {
          buildImage: LinuxBuildImage.STANDARD_5_0,
        },
      }
    );
    const buildArtifact = new Artifact();
    const buildAction = new CodeBuildAction({
      actionName: "PlanningPokerAppBuildAction",
      input: sourceOutput,
      project: buildProject,
      outputs: [buildArtifact],
      environmentVariables: {
        REACT_APP_WEB_SOCKET_URL: {
          value: process.env.REACT_APP_WEB_SOCKET_URL,
        },
        REACT_APP_API_URL: {
          value: process.env.REACT_APP_API_URL,
        },
      },
    });

    const bucket = new Bucket(this, "PlanningPokerAppBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      accessControl: BucketAccessControl.PRIVATE,
    });
    const oai = new OriginAccessIdentity(this, "OriginAccessIdentity");
    const bucketPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["s3:GetObject"],
      principals: [
        new CanonicalUserPrincipal(
          oai.cloudFrontOriginAccessIdentityS3CanonicalUserId
        ),
      ],
      resources: [bucket.bucketArn + "/*"],
    });
    bucket.addToResourcePolicy(bucketPolicy);

    const deployAction = new S3DeployAction({
      actionName: "PlanningPokerAppDeployAction",
      bucket: bucket,
      input: buildArtifact,
    });

    const pipeline = new Pipeline(this, "PlanningPokerAppPipeline", {
      pipelineName: "PlanningPokerAppPipeline",
      stages: [
        { stageName: "Source", actions: [sourceAction] },
        { stageName: "Build", actions: [buildAction] },
        { stageName: "Deploy", actions: [deployAction] },
        // { stageName: 'Invalidate', actions: [] },
      ],
    });

    new Distribution(this, "PlanningPokerAppDistribution", {
      defaultBehavior: {
        origin: new S3Origin(bucket, {
          originAccessIdentity: oai,
        }),
        allowedMethods: AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          ttl: Duration.seconds(300),
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: "/error.html",
        },
        {
          ttl: Duration.seconds(300),
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: "/error.html",
        },
      ],
      enableIpv6: true,
      httpVersion: HttpVersion.HTTP2,
      priceClass: PriceClass.PRICE_CLASS_ALL,
    });
  }
}
