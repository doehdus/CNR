/* Transparent energy/noise tradeoff; no claim about intelligibility optimality.
 * Pareto frontier: minimize the largest loss among total Clean, 2-4 kHz Clean
 * and 4-8 kHz Clean (worst recording for each), maximize equal-condition mean
 * noise reduction. Knee score is normalized noise benefit minus
 * normalized loss, using bypass and the maximum-noise-reduction frontier end.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {char id[80];double loss,noise,snr,score;int frontier,rank;} Point;
static void fail(const char *s){fprintf(stderr,"BPF ranking failed: %s\n",s);exit(1);}
int main(int argc,char **argv){
    FILE *in,*out;char line[8192];Point *p;int n=0,i,j,anchor=0;double gain,loss;
    if(argc!=3)fail("expected metrics.csv NEW_ranking.csv");
    out=fopen(argv[2],"rb");if(out){fclose(out);fail("output exists");}
    in=fopen(argv[1],"rb");if(!in)fail("cannot read metrics");
    p=calloc(32768,sizeof(Point));if(!p)fail("allocation failed");
    if(!fgets(line,sizeof(line),in))fail("missing header");
    while(fgets(line,sizeof(line),in)){
        double a[18];int got;
        if(n>=32768)fail("too many candidates");
        got=sscanf(line,"%79[^,],%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf",p[n].id,a,a+1,a+2,a+3,a+4,a+5,a+6,a+7,a+8,a+9,a+10,a+11,a+12,a+13,a+14,a+15,a+16,a+17);
        if(got!=19)fail("invalid metrics row");
        /* Protect weak high-frequency speech as well as total power. */
        p[n].loss=fmax(100-a[6],fmax(100-a[8],100-a[9]));p[n].noise=a[10];p[n].snr=a[11];
        if(!isfinite(p[n].loss)||!isfinite(p[n].noise))fail("invalid metric");
        if(p[n].noise>p[anchor].noise)anchor=n;n++;
    }
    fclose(in);gain=p[anchor].noise;loss=p[anchor].loss;
    if(n<2||!(gain>0&&loss>0))fail("nontrivial tradeoff required");
    for(i=0;i<n;i++){
        p[i].frontier=1;p[i].score=p[i].noise/gain-p[i].loss/loss;
        for(j=0;j<n;j++)if(p[j].loss<=p[i].loss&&p[j].noise>=p[i].noise&&(p[j].loss<p[i].loss||p[j].noise>p[i].noise)){p[i].frontier=0;break;}
    }
    for(i=0;i<n;i++)if(p[i].frontier){p[i].rank=1;for(j=0;j<n;j++)if(p[j].frontier&&(p[j].score>p[i].score||(p[j].score==p[i].score&&strcmp(p[j].id,p[i].id)<0)))p[i].rank++;}
    out=fopen(argv[2],"wb");if(!out)fail("cannot create ranking");
    fprintf(out,"candidate_id,worst_speech_loss_metric_percent,mean_noise_reduction_db,mean_snr_change_db,balanced_score,pareto,frontier_rank,anchor_noise_db,anchor_loss_percent\n");
    for(i=0;i<n;i++)fprintf(out,"%s,%.17g,%.17g,%.17g,%.17g,%d,%d,%.17g,%.17g\n",p[i].id,p[i].loss,p[i].noise,p[i].snr,p[i].score,p[i].frontier,p[i].rank,gain,loss);
    if(ferror(out)||fclose(out))fail("write failed");free(p);return 0;
}
